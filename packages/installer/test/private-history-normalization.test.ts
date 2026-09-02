import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PRIVATE_HISTORY_NORMALIZATION_MANIFEST,
  normalizePrivateHistory,
  privateHistoryProcessCensus,
  privateHistoryNormalizationSqliteAdapter,
  type PrivateHistoryNormalizationSqliteAdapter,
  type PrivateHistoryRolloutUpdate,
  type PrivateHistoryThreadRow,
} from "../src/private-history-normalization.ts";
import {
  OFFICIAL_CODEX_DATABASES,
  type HistoryAdoptionCensus,
} from "../src/account-history-adoption.ts";

const THREAD_A = "01a05546-cf93-7383-96ed-dc76ce3d1b3c";
const THREAD_B = "01a05547-cf93-7383-96ed-dc76ce3d1b3c";
const THREAD_C = "01a05548-cf93-7383-96ed-dc76ce3d1b3c";
const FIXED_TIME = "2026-09-02T01:00:00.000Z";

test("trusted desktop identities remain additive even when a caller supplies another app path", () => {
  const census = privateHistoryProcessCensus([
    "  410 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "  411 /Applications/Tweakers.app/Contents/MacOS/ChatGPT --type=renderer",
    "  412 codex app-server",
  ].join("\n"), "/Applications/Unused.app", 999_999);
  assert.deepEqual(census, { app: "running", main: "running", appServer: "running" });

  const legacy = privateHistoryProcessCensus(
    "  510 /Applications/Tweakers ChatGPT.app/Contents/MacOS/ChatGPT",
    "/Applications/Unused.app",
    999_999,
  );
  assert.equal(legacy.app, "running");
  assert.equal(legacy.main, "running");
});

class SyntheticSqlite implements PrivateHistoryNormalizationSqliteAdapter {
  readonly rows = new Map<string, PrivateHistoryThreadRow[]>();
  readonly backupCalls: Array<{ source: string; destination: string }> = [];
  readonly rewriteCalls: Array<{ path: string; updates: readonly PrivateHistoryRolloutUpdate[] }> = [];
  readonly integrityCalls: string[] = [];

  backup(source: string, destination: string): void {
    this.backupCalls.push({ source, destination });
    copyFileSync(source, destination);
    const rows = this.rows.get(source);
    if (rows) this.rows.set(destination, structuredClone(rows));
  }

  integrityCheck(path: string): "ok" {
    this.integrityCalls.push(path);
    return "ok";
  }

  readThreadRows(path: string): readonly PrivateHistoryThreadRow[] {
    const tracked = this.rows.get(path);
    if (tracked) return structuredClone(tracked);
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (Array.isArray(parsed)) return parsed as PrivateHistoryThreadRow[];
      } catch {
        // Non-state synthetic database bytes have no thread rows.
      }
    }
    return [];
  }

  rewriteThreadRolloutPaths(path: string, updates: readonly PrivateHistoryRolloutUpdate[]): void {
    this.rewriteCalls.push({ path, updates: structuredClone(updates) });
    const rows = structuredClone(this.rows.get(path) ?? []);
    for (const update of updates) {
      const matches = rows.filter((row) => row.id === update.id && row.rollout_path === update.expectedRolloutPath);
      if (matches.length !== 1) throw new Error("guarded update mismatch");
      matches[0]!.rollout_path = update.rolloutPath;
    }
    this.rows.set(path, rows);
    writeFileSync(path, JSON.stringify(rows), { mode: 0o600 });
  }
}

class Fixture {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-private-history-")));
  readonly sourceCodexRoot = join(this.root, "legacy-codex");
  readonly sourceSqliteRoot = join(this.root, "legacy-sqlite");
  readonly allowedLinkRoot = join(this.root, "approved-archive");
  readonly snapshotParent = join(this.root, "snapshots");
  readonly snapshotRoot = join(this.snapshotParent, "account-history-source-v1");
  readonly forbiddenRoot = join(this.root, "router-data");
  readonly sourceSessions = join(this.sourceCodexRoot, "sessions");
  readonly sourceRegular = join(this.sourceSessions, "regular.jsonl");
  readonly sourceLinked = join(this.sourceSessions, "linked.jsonl");
  readonly sourceMissing = join(this.sourceSessions, "missing.jsonl");
  readonly archiveLinked = join(this.allowedLinkRoot, "linked.jsonl");
  readonly sourceState = join(this.sourceSqliteRoot, "state_5.sqlite");
  readonly sqlite = new SyntheticSqlite();
  census: HistoryAdoptionCensus = idleCensus();
  private sequence = 0;

  constructor() {
    chmodSync(this.root, 0o700);
    for (const directory of [
      this.sourceCodexRoot,
      this.sourceSqliteRoot,
      this.allowedLinkRoot,
      this.snapshotParent,
      this.forbiddenRoot,
      this.sourceSessions,
    ]) privateDirectory(directory);

    writeRollout(this.sourceRegular, THREAD_A, "regular");
    writeRollout(this.archiveLinked, THREAD_B, "linked");
    symlinkSync(this.archiveLinked, this.sourceLinked);
    writeFileSync(join(this.sourceCodexRoot, "session_index.jsonl"), "{}\n", { mode: 0o600 });
    writeFileSync(join(this.sourceCodexRoot, "auth.json"), "not copied\n", { mode: 0o600 });
    privateDirectory(join(this.sourceCodexRoot, "plugins"));
    writeFileSync(join(this.sourceCodexRoot, "plugins", "not-copied.json"), "{}\n", { mode: 0o600 });

    for (const name of OFFICIAL_CODEX_DATABASES) {
      const path = join(this.sourceSqliteRoot, name);
      writeFileSync(path, `${name}\n`, { mode: 0o600 });
    }
    writeFileSync(join(this.sourceSqliteRoot, "state_5.sqlite-wal"), "not copied\n", { mode: 0o600 });
    this.sqlite.rows.set(this.sourceState, [
      { id: THREAD_A, rollout_path: this.sourceRegular, title: "A", archived: false },
      { id: THREAD_B, rollout_path: this.sourceLinked, title: "B", archived: false },
      { id: THREAD_C, rollout_path: this.sourceMissing, title: "C", archived: true },
    ]);
  }

  run(apply: boolean, beforePhase?: (phase: string) => void) {
    return normalizePrivateHistory({
      sourceCodexRoot: this.sourceCodexRoot,
      sourceSqliteRoot: this.sourceSqliteRoot,
      snapshotRoot: this.snapshotRoot,
      allowedLinkRoot: this.allowedLinkRoot,
      appPath: "/synthetic/ChatGPT.app",
      forbiddenRoots: [this.forbiddenRoot],
      apply,
    }, {
      sqlite: this.sqlite,
      census: () => structuredClone(this.census),
      now: () => FIXED_TIME,
      randomId: () => `${String(++this.sequence).padStart(8, "0")}-safe`,
      beforePhase: beforePhase as ((phase: never) => void) | undefined,
    });
  }
}

test("dry run is zero-write and returns only redacted counts and fingerprints", () => {
  const fixture = new Fixture();
  const sourceLink = readlinkSync(fixture.sourceLinked);
  const sourceRows = fixture.sqlite.readThreadRows(fixture.sourceState);
  const result = fixture.run(false);

  assert.equal(result.status, "dry-run");
  assert.equal(result.nextAction, "apply-normalization");
  assert.equal(result.regularHistoryFiles, 1);
  assert.equal(result.linkedHistoryFiles, 1);
  assert.equal(result.databaseThreadCount, 3);
  assert.equal(result.importedThreadCount, 3);
  assert.equal(result.rewrittenRolloutPaths, 2);
  assert.equal(result.clearedMissingRolloutPaths, 1);
  assert.equal(result.databasesPresent, 6);
  assert.equal(result.sessionIndexPresent, true);
  assert.equal(existsSync(fixture.snapshotRoot), false);
  assert.equal(readlinkSync(fixture.sourceLinked), sourceLink);
  assert.deepEqual(fixture.sqlite.readThreadRows(fixture.sourceState), sourceRows);
  assert.doesNotMatch(JSON.stringify(result), /legacy-codex|approved-archive|01a0554/);
});

test("apply materializes approved links and nulls only the cloned missing pointer", () => {
  const fixture = new Fixture();
  const sourceRows = fixture.sqlite.readThreadRows(fixture.sourceState);
  const sourceLink = readlinkSync(fixture.sourceLinked);
  const archiveBefore = readFileSync(fixture.archiveLinked, "utf8");
  const result = fixture.run(true);

  assert.equal(result.status, "normalized");
  assert.equal(result.nextAction, "run-adoption-dry-run");
  assert.equal(fixture.sqlite.backupCalls.length, OFFICIAL_CODEX_DATABASES.length);
  assert.equal(fixture.sqlite.rewriteCalls.length, 1);
  assert.equal(lstatSync(join(fixture.snapshotRoot, "codex-home", "sessions", "regular.jsonl")).isFile(), true);
  const linkedCopy = join(fixture.snapshotRoot, "codex-home", "sessions", "linked.jsonl");
  assert.equal(lstatSync(linkedCopy).isFile(), true);
  assert.equal(lstatSync(linkedCopy).isSymbolicLink(), false);
  assert.equal(statSync(linkedCopy).nlink, 1);
  assert.equal(statSync(linkedCopy).mode & 0o777, 0o600);
  assert.equal(readFileSync(linkedCopy, "utf8"), archiveBefore);
  assert.equal(existsSync(join(fixture.snapshotRoot, "codex-home", "sessions", "missing.jsonl")), false);
  assert.equal(existsSync(join(fixture.snapshotRoot, "codex-home", "auth.json")), false);
  assert.equal(existsSync(join(fixture.snapshotRoot, "codex-home", "plugins")), false);
  assert.equal(existsSync(join(fixture.snapshotRoot, "sqlite-home", "state_5.sqlite-wal")), false);
  assert.equal(existsSync(join(fixture.snapshotRoot, PRIVATE_HISTORY_NORMALIZATION_MANIFEST)), true);
  assert.deepEqual(readdirSync(join(fixture.snapshotRoot, "sqlite-home")).sort(), [...OFFICIAL_CODEX_DATABASES].sort());

  const candidateState = join(fixture.snapshotRoot, "sqlite-home", "state_5.sqlite");
  const candidateRows = fixture.sqlite.readThreadRows(candidateState);
  assert.equal(candidateRows.length, sourceRows.length);
  assert.equal(candidateRows.find((row) => row.id === THREAD_A)?.rollout_path,
    join(fixture.snapshotRoot, "codex-home", "sessions", "regular.jsonl"));
  assert.equal(candidateRows.find((row) => row.id === THREAD_B)?.rollout_path,
    join(fixture.snapshotRoot, "codex-home", "sessions", "linked.jsonl"));
  assert.equal(candidateRows.find((row) => row.id === THREAD_C)?.rollout_path, null);
  assert.deepEqual(candidateRows.map(({ rollout_path: _path, ...row }) => row),
    sourceRows.map(({ rollout_path: _path, ...row }) => row));

  assert.deepEqual(fixture.sqlite.readThreadRows(fixture.sourceState), sourceRows);
  assert.equal(lstatSync(fixture.sourceLinked).isSymbolicLink(), true);
  assert.equal(readlinkSync(fixture.sourceLinked), sourceLink);
  assert.equal(readFileSync(fixture.archiveLinked, "utf8"), archiveBefore);
});

test("apply uses the real sqlite adapter for a complete private clone", () => {
  const fixture = realSqliteFixture();
  const sourceHistoryBefore = readFileSync(fixture.sourceHistory);
  const sourceIndexBefore = readFileSync(fixture.sourceIndex);
  const sourceDatabaseBytesBefore = new Map(
    fixture.databasePaths.map((path) => [path, readFileSync(path)]),
  );
  const sourceRows = sqliteJson(fixture.sourceState, "SELECT * FROM threads ORDER BY id;\n");
  const sourceMetadata = new Map(
    fixture.databasePaths.map((path) => [path, sqliteJson(path, "SELECT * FROM metadata ORDER BY key;\n")]),
  );

  const result = normalizePrivateHistory({
    sourceCodexRoot: fixture.sourceCodexRoot,
    sourceSqliteRoot: fixture.sourceSqliteRoot,
    snapshotRoot: fixture.snapshotRoot,
    allowedLinkRoot: fixture.allowedLinkRoot,
    appPath: join(fixture.root, "ChatGPT.app"),
    forbiddenRoots: [],
    apply: true,
  }, {
    census: () => idleCensus(),
    now: () => FIXED_TIME,
    randomId: () => "real-sqlite-safe",
  });

  assert.equal(result.status, "normalized");
  assert.equal(result.databasesPresent, OFFICIAL_CODEX_DATABASES.length);
  assert.equal(result.rewrittenRolloutPaths, 1);
  assert.equal(result.clearedMissingRolloutPaths, 1);
  assert.deepEqual(
    readdirSync(join(fixture.snapshotRoot, "sqlite-home")).sort(),
    [...OFFICIAL_CODEX_DATABASES].sort(),
  );

  const candidateRows = sqliteJson(
    join(fixture.snapshotRoot, "sqlite-home", "state_5.sqlite"),
    "SELECT * FROM threads ORDER BY id;\n",
  );
  assert.equal(candidateRows.length, sourceRows.length);
  assert.equal(candidateRows.find((row) => row.id === THREAD_A)?.rollout_path,
    join(fixture.snapshotRoot, "codex-home", "sessions", "real.jsonl"));
  assert.equal(candidateRows.find((row) => row.id === THREAD_B)?.rollout_path, null);
  assert.deepEqual(
    candidateRows.map(({ rollout_path: _path, ...row }) => row),
    sourceRows.map(({ rollout_path: _path, ...row }) => row),
  );

  for (const path of fixture.databasePaths) {
    const candidatePath = join(fixture.snapshotRoot, "sqlite-home", path.slice(fixture.sourceSqliteRoot.length + 1));
    assert.deepEqual(sqliteJson(candidatePath, "SELECT * FROM metadata ORDER BY key;\n"), sourceMetadata.get(path));
    assert.deepEqual(readFileSync(path), sourceDatabaseBytesBefore.get(path));
  }
  assert.deepEqual(readFileSync(fixture.sourceHistory), sourceHistoryBefore);
  assert.deepEqual(readFileSync(fixture.sourceIndex), sourceIndexBefore);
  assert.deepEqual(sqliteJson(fixture.sourceState, "SELECT * FROM threads ORDER BY id;\n"), sourceRows);
});

test("real sqlite guarded rewrites roll back every update when one expected row is stale", () => {
  const fixture = realSqliteFixture();
  const adapter = privateHistoryNormalizationSqliteAdapter();
  const candidateState = join(fixture.root, "guarded-candidate.sqlite");
  adapter.backup(fixture.sourceState, candidateState);
  const before = sqliteJson(candidateState, "SELECT * FROM threads ORDER BY id;\n");

  assert.throws(() => adapter.rewriteThreadRolloutPaths(candidateState, [
    {
      id: THREAD_A,
      expectedRolloutPath: fixture.sourceHistory,
      rolloutPath: join(fixture.root, "normalized-a.jsonl"),
    },
    {
      id: THREAD_B,
      expectedRolloutPath: join(fixture.sourceCodexRoot, "sessions", "not-the-stored-path.jsonl"),
      rolloutPath: null,
    },
  ]), /history-normalization-sqlite-command-failed/);

  // THREAD_A's successful first UPDATE must be rolled back when THREAD_B's
  // exact old-value predicate matches zero rows.
  assert.deepEqual(sqliteJson(candidateState, "SELECT * FROM threads ORDER BY id;\n"), before);
  assert.deepEqual(
    sqliteJson(fixture.sourceState, "SELECT * FROM threads ORDER BY id;\n"),
    before,
  );
});

test("apply refuses a non-idle app before creating a candidate", () => {
  const fixture = new Fixture();
  fixture.census = { ...idleCensus(), app: "running" };
  assert.throws(() => fixture.run(true), /history-normalization-not-idle/);
  assert.equal(existsSync(fixture.snapshotRoot), false);
  assert.equal(readdirSync(fixture.snapshotParent).some((name) => name.includes("history-normalization")), false);
});

test("outside-root and dangling links fail closed during a read-only plan", () => {
  const outside = new Fixture();
  const outsideTarget = join(outside.root, "outside.jsonl");
  writeRollout(outsideTarget, "01a05549-cf93-7383-96ed-dc76ce3d1b3c", "outside");
  symlinkSync(outsideTarget, join(outside.sourceSessions, "outside.jsonl"));
  assert.throws(() => outside.run(false), /history-normalization-link-outside-approved-root/);
  assert.equal(existsSync(outside.snapshotRoot), false);

  const dangling = new Fixture();
  symlinkSync(join(dangling.allowedLinkRoot, "does-not-exist.jsonl"), join(dangling.sourceSessions, "dangling.jsonl"));
  assert.throws(() => dangling.run(false), /history-normalization-linked-history-target/);
  assert.equal(existsSync(dangling.snapshotRoot), false);
});

test("a relocated physical record anywhere in the approved archive blocks a NULL rewrite", () => {
  const fixture = new Fixture();
  const relocatedDirectory = join(fixture.allowedLinkRoot, "relocated", "deeply");
  privateDirectory(join(fixture.allowedLinkRoot, "relocated"));
  privateDirectory(relocatedDirectory);
  writeRollout(join(relocatedDirectory, "different-name.jsonl"), THREAD_C, "recoverable");

  assert.throws(() => fixture.run(false), /history-normalization-missing-path-recoverable/);
  assert.equal(existsSync(fixture.snapshotRoot), false);
  assert.equal(existsSync(fixture.sourceMissing), false);
});

test("the approved archive inventory rejects symlinks and hardlinks", () => {
  const linkedArchive = new Fixture();
  const outside = join(linkedArchive.root, "archive-outside.jsonl");
  writeRollout(outside, "01a05549-cf93-7383-96ed-dc76ce3d1b3c", "outside");
  symlinkSync(outside, join(linkedArchive.allowedLinkRoot, "unexpected-link.jsonl"));
  assert.throws(() => linkedArchive.run(false), /history-normalization-archive-symlink-refused/);

  const hardlinkedArchive = new Fixture();
  const hardlinkSource = join(hardlinkedArchive.allowedLinkRoot, "hardlink-source.jsonl");
  writeRollout(hardlinkSource, "01a0554a-cf93-7383-96ed-dc76ce3d1b3c", "hardlink");
  linkSync(hardlinkSource, join(hardlinkedArchive.allowedLinkRoot, "hardlink-copy.jsonl"));
  assert.throws(() => hardlinkedArchive.run(false), /history-normalization-archive-entry-unsafe/);
});

test("publication refuses a swapped snapshot parent and retains the private candidate", () => {
  const fixture = new Fixture();
  const originalParent = `${fixture.snapshotParent}-original`;
  assert.throws(() => fixture.run(true, (phase) => {
    if (phase !== "before-publication") return;
    renameSync(fixture.snapshotParent, originalParent);
    privateDirectory(fixture.snapshotParent);
  }), /history-normalization-snapshot-publication-path-drift/);

  assert.equal(existsSync(fixture.snapshotRoot), false);
  assert.equal(readdirSync(fixture.snapshotParent).length, 0);
  assert.equal(readdirSync(originalParent)
    .filter((name) => name.startsWith(".history-normalization-failed-")).length, 1);
});

test("source drift aborts publication and retains the failed private candidate", () => {
  const fixture = new Fixture();
  assert.throws(() => fixture.run(true, (phase) => {
    if (phase === "after-history-copied") appendFileSync(fixture.sourceRegular, "{\"late\":true}\n");
  }), /history-normalization-(?:source-drift|hash-source-drift)/);
  assert.equal(existsSync(fixture.snapshotRoot), false);
  const failed = readdirSync(fixture.snapshotParent).filter((name) => name.startsWith(".history-normalization-failed-"));
  assert.equal(failed.length, 1);
  assert.equal(statSync(join(fixture.snapshotParent, failed[0]!)).mode & 0o777, 0o700);
});

function idleCensus(): HistoryAdoptionCensus {
  return {
    app: "idle",
    main: "idle",
    appServer: "idle",
    openFileCount: 0,
    observedAt: FIXED_TIME,
  };
}

function privateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeRollout(path: string, id: string, marker: string): void {
  writeFileSync(path,
    `${JSON.stringify({ type: "session_meta", payload: { id } })}\n${JSON.stringify({ marker })}\n`,
    { mode: 0o600 });
}

function realSqliteFixture(): {
  root: string;
  sourceCodexRoot: string;
  sourceSqliteRoot: string;
  allowedLinkRoot: string;
  snapshotRoot: string;
  sourceHistory: string;
  sourceIndex: string;
  sourceState: string;
  databasePaths: string[];
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-real-sqlite-history-")));
  const sourceCodexRoot = join(root, "legacy-codex");
  const sourceSqliteRoot = join(root, "legacy-sqlite");
  const allowedLinkRoot = join(root, "approved-archive");
  const snapshotRoot = join(root, "snapshots", "account-history-source-v1");
  const sourceSessions = join(sourceCodexRoot, "sessions");
  const sourceHistory = join(sourceSessions, "real.jsonl");
  const sourceIndex = join(sourceCodexRoot, "session_index.jsonl");
  const sourceState = join(sourceSqliteRoot, "state_5.sqlite");

  for (const directory of [
    sourceCodexRoot,
    sourceSqliteRoot,
    allowedLinkRoot,
    join(root, "snapshots"),
    sourceSessions,
  ]) privateDirectory(directory);
  writeRollout(sourceHistory, THREAD_A, "real");
  writeFileSync(sourceIndex, "{}\n", { mode: 0o600 });

  const databasePaths = OFFICIAL_CODEX_DATABASES.map((name) => join(sourceSqliteRoot, name));
  for (const path of databasePaths) {
    const isState = path === sourceState;
    createSqliteFixture(path, isState ? [
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, archived INTEGER, priority INTEGER);",
      `INSERT INTO threads VALUES ('${THREAD_A}', '${sourceHistory}', 'Real A', 0, 7);`,
      `INSERT INTO threads VALUES ('${THREAD_B}', '${join(sourceSessions, "missing.jsonl")}', 'Missing B', 1, 9);`,
    ] : []);
  }
  return {
    root,
    sourceCodexRoot,
    sourceSqliteRoot,
    allowedLinkRoot,
    snapshotRoot,
    sourceHistory,
    sourceIndex,
    sourceState,
    databasePaths,
  };
}

function createSqliteFixture(path: string, extraStatements: readonly string[]): void {
  const statements = [
    "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    "INSERT INTO metadata VALUES ('fixture', 'real-sqlite');",
    ...extraStatements,
  ];
  const result = spawnSync("/usr/bin/sqlite3", [path], {
    encoding: "utf8",
    input: `${statements.join("\n")}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  chmodSync(path, 0o600);
}

function sqliteJson(path: string, sql: string): Array<Record<string, unknown>> {
  const result = spawnSync("/usr/bin/sqlite3", ["-json", path], {
    encoding: "utf8",
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as unknown;
  assert.ok(Array.isArray(parsed));
  return parsed as Array<Record<string, unknown>>;
}

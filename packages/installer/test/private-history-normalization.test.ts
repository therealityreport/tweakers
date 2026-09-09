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
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
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
const THREAD_D = "01a05549-cf93-7383-96ed-dc76ce3d1b3c";
const THREAD_E = "01a0554a-cf93-7383-96ed-dc76ce3d1b3c";
const FIXED_TIME = "2026-09-02T01:00:00.000Z";
const ARCHIVE_EXACT_METADATA_PATHS = [
  "archived_sessions/keep-codex-fast-20260531-161915/RESTORE_MANIFEST.json",
  "archived_sessions/keep-codex-fast-20260531-173902/RESTORE_MANIFEST.json",
  "archived_sessions/completed-or-obsolete-2026-08-26/MANIFEST.json",
  "archived_sessions/.relocation-manifest.json",
  "session-cold-storage/2026-08-20-older-than-14-days/manifest.json",
  "session-cold-storage/2026-08-20-older-than-14-days/manifest.sha256",
  "session-cold-storage/2026-08-20-older-than-14-days/conversion-journal.jsonl",
  "session-cold-storage/2026-08-20-older-than-14-days/metadata/state_5-before.sqlite",
  "session-cold-storage/2026-08-20-older-than-14-days/metadata/state_5-before.sqlite-wal",
  "session-cold-storage/2026-08-20-older-than-14-days/metadata/state_5-before.sqlite-shm",
] as const;

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

  run(
    apply: boolean,
    beforePhase?: (phase: string) => void,
    options: {
      archiveRecoveryByteCap?: number;
      freeSpaceBytes?: (path: string) => bigint;
    } = {},
  ) {
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
      archiveRecoveryByteCap: options.archiveRecoveryByteCap,
      freeSpaceBytes: options.freeSpaceBytes,
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

test("an archive-only plain rollout recovers a stale database path into the deterministic private namespace", () => {
  const fixture = new Fixture();
  const relocatedDirectory = join(fixture.allowedLinkRoot, "relocated", "deeply");
  privateDirectory(join(fixture.allowedLinkRoot, "relocated"));
  privateDirectory(relocatedDirectory);
  writeRollout(join(relocatedDirectory, "different-name.jsonl"), THREAD_C, "recoverable");
  const archiveBefore = readFileSync(join(relocatedDirectory, "different-name.jsonl"));
  const sourceRows = fixture.sqlite.readThreadRows(fixture.sourceState);

  const result = fixture.run(true);
  const recovered = join(
    fixture.snapshotRoot,
    "codex-home",
    "archived_sessions",
    "recovered-by-tweakers-v1",
    `${THREAD_C}.jsonl`,
  );
  assert.equal(result.status, "normalized");
  assert.equal(result.recoveredArchiveRolloutPaths, 1);
  assert.equal(result.decompressedArchiveFiles, 0);
  assert.equal(result.clearedMissingRolloutPaths, 0);
  assert.deepEqual(readFileSync(recovered), archiveBefore);
  assert.equal(lstatSync(recovered).isSymbolicLink(), false);
  assert.equal(statSync(recovered).mode & 0o777, 0o600);
  assert.equal(
    fixture.sqlite.readThreadRows(join(fixture.snapshotRoot, "sqlite-home", "state_5.sqlite"))
      .find((row) => row.id === THREAD_C)?.rollout_path,
    recovered,
  );
  assert.deepEqual(fixture.sqlite.readThreadRows(fixture.sourceState), sourceRows);
  assert.equal(existsSync(fixture.sourceMissing), false);
});

test("a stale local pointer reuses an existing same-ID source rollout before consulting the archive", () => {
  const fixture = new Fixture();
  const relocated = join(fixture.sourceSessions, "relocated-source.jsonl");
  writeRollout(relocated, THREAD_C, "source-stale-recovery");
  const sourceRows = fixture.sqlite.readThreadRows(fixture.sourceState);

  const result = fixture.run(true);
  const copied = join(fixture.snapshotRoot, "codex-home", "sessions", "relocated-source.jsonl");
  assert.equal(result.status, "normalized");
  assert.equal(result.recoveredSourceStaleRolloutPaths, 1);
  assert.equal(result.recoveredArchiveRolloutPaths, 0);
  assert.equal(result.clearedMissingRolloutPaths, 0);
  assert.equal(
    fixture.sqlite.readThreadRows(join(fixture.snapshotRoot, "sqlite-home", "state_5.sqlite"))
      .find((row) => row.id === THREAD_C)?.rollout_path,
    copied,
  );
  assert.equal(lstatSync(copied).isSymbolicLink(), false);
  assert.deepEqual(fixture.sqlite.readThreadRows(fixture.sourceState), sourceRows);
});

test("a gzip archive rollout is planned by decompressed metadata and streamed into a private normalized file", () => {
  const fixture = new Fixture();
  const archive = join(fixture.allowedLinkRoot, "cold", "unrelated-name.jsonl.gz");
  writeGzipRollout(archive, THREAD_D, "gzip-recovery");
  addThread(fixture, THREAD_D, join(fixture.sourceSessions, "stale-gzip.jsonl"));
  const sourceRows = fixture.sqlite.readThreadRows(fixture.sourceState);
  const archiveBefore = readFileSync(archive);

  const dryRun = fixture.run(false);
  assert.equal(dryRun.recoveredArchiveRolloutPaths, 1);
  assert.equal(dryRun.decompressedArchiveFiles, 1);
  assert.equal(dryRun.decompressedArchiveBytes, 0);
  assert.equal(existsSync(fixture.snapshotRoot), false);

  const result = fixture.run(true);
  const recovered = join(
    fixture.snapshotRoot,
    "codex-home",
    "archived_sessions",
    "recovered-by-tweakers-v1",
    `${THREAD_D}.jsonl`,
  );
  const expected = rolloutBytes(THREAD_D, "gzip-recovery");
  assert.equal(result.status, "normalized");
  assert.equal(result.decompressedArchiveFiles, 1);
  assert.equal(result.decompressedArchiveBytes, expected.byteLength);
  assert.deepEqual(readFileSync(recovered), expected);
  assert.equal(statSync(recovered).mode & 0o777, 0o600);
  assert.equal(lstatSync(recovered).isSymbolicLink(), false);
  assert.equal(
    fixture.sqlite.readThreadRows(join(fixture.snapshotRoot, "sqlite-home", "state_5.sqlite"))
      .find((row) => row.id === THREAD_D)?.rollout_path,
    recovered,
  );
  assert.deepEqual(fixture.sqlite.readThreadRows(fixture.sourceState), sourceRows);
  assert.deepEqual(readFileSync(archive), archiveBefore);

  const manifest = JSON.parse(readFileSync(join(fixture.snapshotRoot, PRIVATE_HISTORY_NORMALIZATION_MANIFEST), "utf8")) as {
    archiveRecovery: { entries: Array<Record<string, unknown>> };
  };
  const entry = manifest.archiveRecovery.entries.find((value) => value.snapshotRelativePath === `archived_sessions/recovered-by-tweakers-v1/${THREAD_D}.jsonl`);
  assert.ok(entry);
  assert.equal(entry.encoding, "gzip");
  assert.equal(entry.normalizedBytes, expected.byteLength);
  assert.match(String(entry.compressedSha256), /^sha256:[a-f0-9]{64}$/);
  assert.match(String(entry.normalizedSha256), /^sha256:[a-f0-9]{64}$/);
});

test("gzip recovery accepts concatenated members only after streaming every member to EOF", () => {
  const fixture = new Fixture();
  const archive = join(fixture.allowedLinkRoot, "concatenated.jsonl.gz");
  const first = rolloutBytes(THREAD_D, "first-member");
  const second = Buffer.from("{\"marker\":\"second-member\"}\n", "utf8");
  const expected = Buffer.concat([first, second]);
  writeFileSync(archive, Buffer.concat([gzipSync(first), gzipSync(second)]), { mode: 0o600 });
  addThread(fixture, THREAD_D, join(fixture.sourceSessions, "stale-concatenated.jsonl"));

  const result = fixture.run(true);
  const recovered = join(
    fixture.snapshotRoot,
    "codex-home",
    "archived_sessions",
    "recovered-by-tweakers-v1",
    `${THREAD_D}.jsonl`,
  );
  assert.equal(result.status, "normalized");
  assert.equal(result.decompressedArchiveBytes, expected.byteLength);
  assert.deepEqual(readFileSync(recovered), expected);
});

test("exact archive and source metadata exclusions are hashed, omitted, and do not broaden to unfamiliar controls", () => {
  const fixture = new Fixture();
  writeFileSync(join(fixture.sourceSessions, ".DS_Store"), "source finder metadata", { mode: 0o600 });
  writeFileSync(join(fixture.sourceSessions, "._regular.jsonl"), "source apple double", { mode: 0o600 });
  for (const relativePath of ARCHIVE_EXACT_METADATA_PATHS) {
    writeArchiveControl(fixture.allowedLinkRoot, relativePath, `control:${relativePath}`);
  }
  writeArchiveControl(fixture.allowedLinkRoot, "cold/.DS_Store", "archive finder metadata");
  writeArchiveControl(fixture.allowedLinkRoot, "cold/._rollout.jsonl", "archive apple double");

  const dryRun = fixture.run(false);
  assert.equal(dryRun.excludedMetadataFiles, 14);
  const result = fixture.run(true);
  assert.equal(result.status, "normalized");
  assert.equal(existsSync(join(fixture.snapshotRoot, "codex-home", "sessions", ".DS_Store")), false);
  assert.equal(existsSync(join(fixture.snapshotRoot, "codex-home", "sessions", "._regular.jsonl")), false);

  const unknown = new Fixture();
  writeArchiveControl(unknown.allowedLinkRoot, "archived_sessions/not-approved/MANIFEST.json", "not approved");
  assert.throws(() => unknown.run(false), /history-normalization-archive-entry-unknown/);

  const malformed = new Fixture();
  writeArchiveControl(malformed.allowedLinkRoot, "unknown.jsonl", "{not-json}\n");
  assert.throws(() => malformed.run(false), /history-normalization-invalid-rollout-first-record/);

  const wrongMagic = new Fixture();
  writeArchiveControl(wrongMagic.allowedLinkRoot, "wrong-magic.jsonl.gz", rolloutBytes(THREAD_D, "plain-but-gzip-named").toString("utf8"));
  assert.throws(() => wrongMagic.run(false), /history-normalization-archive-rollout-encoding-mismatch/);

  const unknownSource = new Fixture();
  writeFileSync(join(unknownSource.sourceSessions, "unknown.txt"), "not a rollout\n", { mode: 0o600 });
  assert.throws(() => unknownSource.run(false), /history-normalization-invalid-rollout-first-record/);
});

test("gzip recovery fails closed on CRC/truncation, compressed drift, output drift, and a bounded decompression cap", () => {
  const truncated = new Fixture();
  const truncatedArchive = join(truncated.allowedLinkRoot, "truncated.jsonl.gz");
  writeGzipRollout(truncatedArchive, THREAD_D, "truncated".repeat(4096));
  writeFileSync(truncatedArchive, readFileSync(truncatedArchive).subarray(0, -4), { mode: 0o600 });
  addThread(truncated, THREAD_D, join(truncated.sourceSessions, "stale-truncated.jsonl"));
  const sourceRows = truncated.sqlite.readThreadRows(truncated.sourceState);
  assert.throws(() => truncated.run(true), /history-normalization-archive-gzip-decompression-failed/);
  assert.deepEqual(truncated.sqlite.readThreadRows(truncated.sourceState), sourceRows);
  assert.equal(existsSync(truncated.snapshotRoot), false);

  const drift = new Fixture();
  const driftArchive = join(drift.allowedLinkRoot, "drift.jsonl.gz");
  writeGzipRollout(driftArchive, THREAD_D, "before-drift");
  addThread(drift, THREAD_D, join(drift.sourceSessions, "stale-drift.jsonl"));
  assert.throws(() => drift.run(true, (phase) => {
    if (phase === "after-candidate-created") writeGzipRollout(driftArchive, THREAD_E, "after-drift");
  }), /history-normalization-archive-file-drift/);

  const outputDrift = new Fixture();
  const outputArchive = join(outputDrift.allowedLinkRoot, "output-drift.jsonl.gz");
  writeGzipRollout(outputArchive, THREAD_D, "output-drift");
  addThread(outputDrift, THREAD_D, join(outputDrift.sourceSessions, "stale-output.jsonl"));
  assert.throws(() => outputDrift.run(true, (phase) => {
    if (phase !== "after-history-copied") return;
    const candidate = readdirSync(outputDrift.snapshotParent)
      .find((name) => name.startsWith(".history-normalization-candidate-"));
    assert.ok(candidate);
    appendFileSync(join(outputDrift.snapshotParent, candidate, "codex-home", "archived_sessions", "recovered-by-tweakers-v1", `${THREAD_D}.jsonl`), "late\n");
  }), /history-normalization-normalized-history-mismatch/);

  const capped = new Fixture();
  const cappedArchive = join(capped.allowedLinkRoot, "capped.jsonl.gz");
  writeGzipRollout(cappedArchive, THREAD_D, "x".repeat(512));
  addThread(capped, THREAD_D, join(capped.sourceSessions, "stale-capped.jsonl"));
  assert.throws(
    () => capped.run(true, undefined, { archiveRecoveryByteCap: 64 }),
    /history-normalization-archive-gzip-decompression-failed/,
  );
});

test("each gzip recovery reserves its cap plus databases and later exact plain archive work", () => {
  const fixture = new Fixture();
  const gzipArchive = join(fixture.allowedLinkRoot, "first-recovery.jsonl.gz");
  const secondGzipArchive = join(fixture.allowedLinkRoot, "second-recovery.jsonl.gz");
  const plainArchive = join(fixture.allowedLinkRoot, "later-recovery.jsonl");
  writeGzipRollout(gzipArchive, THREAD_C, "first-gzip-recovery");
  writeGzipRollout(secondGzipArchive, THREAD_D, "second-gzip-recovery");
  writeRollout(plainArchive, THREAD_E, "later-plain-recovery");
  addThread(fixture, THREAD_D, join(fixture.sourceSessions, "stale-second-gzip.jsonl"));
  addThread(fixture, THREAD_E, join(fixture.sourceSessions, "stale-later-plain.jsonl"));

  const outputCap = 1024;
  const databaseBytes = OFFICIAL_CODEX_DATABASES.reduce(
    (sum, name) => sum + BigInt(statSync(join(fixture.sourceSqliteRoot, name)).size),
    0n,
  );
  const plainBytes = BigInt(statSync(plainArchive).size);
  const requiredForSecondGzip = BigInt(outputCap) + databaseBytes + plainBytes;
  // Preflight and the first gzip have ample capacity. The second gzip sees
  // enough for its cap alone but not enough to preserve the later DB/plain work.
  const freeSpaceObservations = [10_000_000n, 10_000_000n, requiredForSecondGzip - 1n];
  const sourceRows = fixture.sqlite.readThreadRows(fixture.sourceState);

  assert.throws(
    () => fixture.run(true, undefined, {
      archiveRecoveryByteCap: outputCap,
      freeSpaceBytes: () => freeSpaceObservations.shift() ?? 0n,
    }),
    /history-normalization-snapshot-free-space-insufficient/,
  );
  assert.equal(freeSpaceObservations.length, 0);
  assert.deepEqual(fixture.sqlite.readThreadRows(fixture.sourceState), sourceRows);
  assert.equal(existsSync(fixture.snapshotRoot), false);
});

test("duplicate and divergent archive claims fail, while an exact source symlink to an archive plain rollout remains one record", () => {
  const duplicate = new Fixture();
  writeRollout(join(duplicate.allowedLinkRoot, "duplicate-one.jsonl"), THREAD_D, "one");
  writeRollout(join(duplicate.allowedLinkRoot, "duplicate-two.jsonl"), THREAD_D, "two");
  assert.throws(() => duplicate.run(false), /history-normalization-duplicate-rollout-thread-id/);

  const divergent = new Fixture();
  writeRollout(join(divergent.allowedLinkRoot, "different-source-a.jsonl"), THREAD_A, "different");
  assert.throws(() => divergent.run(false), /history-normalization-source-archive-rollout-divergence/);

  const exactSymlink = new Fixture();
  assert.doesNotThrow(() => exactSymlink.run(false));
});

test("metadata drift and a preexisting recovery namespace block publication without altering originals", () => {
  const metadataDrift = new Fixture();
  const sourceMetadata = join(metadataDrift.sourceSessions, ".DS_Store");
  writeFileSync(sourceMetadata, "before", { mode: 0o600 });
  assert.throws(() => metadataDrift.run(true, (phase) => {
    if (phase === "after-history-copied") appendFileSync(sourceMetadata, "after");
  }), /history-normalization-source-drift/);
  assert.equal(existsSync(metadataDrift.snapshotRoot), false);

  const archiveMetadataDrift = new Fixture();
  const archiveMetadata = join(archiveMetadataDrift.allowedLinkRoot, ".DS_Store");
  writeFileSync(archiveMetadata, "before", { mode: 0o600 });
  assert.throws(() => archiveMetadataDrift.run(true, (phase) => {
    if (phase === "after-history-copied") appendFileSync(archiveMetadata, "after");
  }), /history-normalization-source-drift/);
  assert.equal(existsSync(archiveMetadataDrift.snapshotRoot), false);

  const collision = new Fixture();
  const archived = join(collision.sourceCodexRoot, "archived_sessions");
  privateDirectory(archived);
  privateDirectory(join(archived, "recovered-by-tweakers-v1"));
  assert.throws(() => collision.run(false), /history-normalization-archive-recovery-namespace-exists/);
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
  writeFileSync(path, rolloutBytes(id, marker), { mode: 0o600 });
}

function rolloutBytes(id: string, marker: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({ type: "session_meta", payload: { id } })}\n${JSON.stringify({ marker })}\n`,
    "utf8",
  );
}

function writeGzipRollout(path: string, id: string, marker: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, gzipSync(rolloutBytes(id, marker)), { mode: 0o600 });
}

function writeArchiveControl(root: string, relativePath: string, contents: string): void {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
}

function addThread(fixture: Fixture, id: string, rolloutPath: string): void {
  const rows = fixture.sqlite.rows.get(fixture.sourceState);
  assert.ok(rows);
  rows.push({ id, rollout_path: rolloutPath, title: `Thread ${id}`, archived: true });
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

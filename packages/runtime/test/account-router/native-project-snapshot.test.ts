import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeProjectSnapshotReaderV1, NativeProjectSnapshotPagesV1, nativeProjectRpcRowV1, parseSavedNativeProjectsV1, type NativeProjectSnapshotV1 } from "../../src/account-router/native-project-snapshot";
import { NativeLegacyProjectsV1 } from "../../src/account-router/native-legacy-projects";
import { routerConfigFingerprint } from "../../src/account-router/config";
import { nativeHistoryAccountSetFingerprintV1, nativeHistoryAuthIdentityHmacV1, readAndPreflightNativeHistorySourceStaticV1, signNativeHistorySourceV1 } from "../../src/account-router/native-history";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type OpaqueAccountId, type RouterConfigV3 } from "../../src/account-router/types";

const account = `ar_${"a".repeat(43)}` as OpaqueAccountId;
const otherAccount = `ar_${"b".repeat(43)}` as OpaqueAccountId;
function savedRows() {
  const columns = (rows: Array<[string, string, number, string | null, number]>) => rows.map(([name, type, notnull, value, pk], cid) => ({ cid, name, type, notnull, default: value, pk, hidden: 0 }));
  return {
    tables: [{ name: "projects", type: "table" }, { name: "project_roots", type: "table" }],
    projectColumns: columns([["id", "TEXT", 0, null, 1], ["name", "TEXT", 1, null, 0], ["metadata", "TEXT", 1, "'{}'", 0], ["position", "INTEGER", 1, null, 0], ["created_at_ms", "INTEGER", 1, null, 0], ["updated_at_ms", "INTEGER", 1, null, 0]]),
    rootColumns: columns([["project_id", "TEXT", 1, null, 1], ["position", "INTEGER", 1, null, 2], ["path", "TEXT", 1, null, 0]]),
    foreignKeys: [{ id: 0, seq: 0, table: "projects", from: "project_id", to: "id", onUpdate: "NO ACTION", onDelete: "CASCADE", match: "NONE" }], triggers: 0,
    migrations: [{ version: 59, description: "thread attachment reverse lookup", success: 1, checksum: "4297DFFB4FB308F0C665E4D126B7D2A96DB7BE48EB2E13C7E1245A5D95C4DF4E66D64E79AD00FEC26B0910436703090C" }],
    projects: [{ id: "project-a", name: "Tweakers", metadata: JSON.stringify({ "appearance.color": "blue", custom: { value: 1 } }), position: 0, createdAt: 12, updatedAt: 34 }],
    roots: [{ projectId: "project-a", position: 0, path: "/Users/thomashulihan/Projects/tweakers" }],
  };
}

test("saved schema59 records preserve metadata, milliseconds, and the user root alias", () => {
  assert.deepEqual(parseSavedNativeProjectsV1(savedRows()), [{ id: "project-a", name: "Tweakers", metadata: { "appearance.color": "blue", custom: { value: 1 } }, roots: [{ path: "/Users/thomashulihan/Projects/tweakers" }], createdAt: 12, updatedAt: 34 }]);
});

test("saved projects reject unsupported migrations, schema/FK drift, invalid metadata, orphan/duplicate roots and bounds", () => {
  const mutations: Array<(rows: ReturnType<typeof savedRows>) => void> = [
    (rows) => { rows.projectColumns[1]!.notnull = 0; }, (rows) => { rows.projectColumns[2]!.default = null; },
    (rows) => { rows.rootColumns[1]!.pk = 0; }, (rows) => { rows.foreignKeys[0]!.onDelete = "NO ACTION"; },
    (rows) => { rows.triggers = 1; }, (rows) => { rows.migrations[0]!.version = 60; },
    (rows) => { rows.migrations[0]!.success = 0; }, (rows) => { rows.migrations[0]!.checksum = "0".repeat(96); },
    (rows) => { rows.projects[0]!.metadata = "[]"; }, (rows) => { rows.roots[0]!.projectId = "missing"; },
    (rows) => { rows.roots.push({ ...rows.roots[0]! }); }, (rows) => { rows.projects[0]!.createdAt = -1; },
    (rows) => { rows.projects = Array.from({ length: 513 }, (_, index) => ({ ...rows.projects[0]!, id: `p-${index}` })); },
    (rows) => { rows.projects[0]!.metadata = JSON.stringify({ huge: "a".repeat(8 * 1024 * 1024) }); },
  ];
  for (const mutate of mutations) { const rows = savedRows(); mutate(rows); assert.equal(parseSavedNativeProjectsV1(rows), null); }
});

function snapshot(): NativeProjectSnapshotV1 { return { account, fingerprint: "source-a", source: "saved_local", projects: [{ id: "a" }, { id: "b" }, { id: "c" }] }; }
test("nullable native list limit uses the same default page as an omitted limit", () => {
  const pages = new NativeProjectSnapshotPagesV1();
  assert.deepEqual(pages.page(snapshot(), account, "source-a", 0, { cursor: null, limit: null }), pages.page(snapshot(), account, "source-a", 0, {}));
});

test("native project RPC exposure uses seconds while saved snapshots keep millisecond precision", () => {
  const saved = { id: "project-a", name: "A", roots: [{ path: "/Users/thomashulihan/Projects/tweakers" }], metadata: { custom: "kept" }, createdAt: 1_700_000_000_123, updatedAt: 1_700_000_456_789 };
  const provider = { ...saved, createdAt: 1_700_000_000, updatedAt: 1_700_000_456 };
  assert.deepEqual(nativeProjectRpcRowV1(saved, "saved_local"), provider);
  assert.deepEqual(nativeProjectRpcRowV1(provider, "app_server"), provider);
  const pages = new NativeProjectSnapshotPagesV1();
  assert.deepEqual(pages.page({ account, fingerprint: "source-a", source: "saved_local", projects: [saved] }, account, "source-a", 0, {})!.data,
    pages.page({ account, fingerprint: "source-a", source: "app_server", projects: [provider] }, account, "source-a", 0, {})!.data);
  assert.equal(saved.createdAt, 1_700_000_000_123, "RPC conversion cannot mutate snapshot/desktop millisecond rows");
});

test("opaque snapshot pagination rejects foreign account, source drift, authority transitions and forged cursors", () => {
  const pages = new NativeProjectSnapshotPagesV1();
  const first = pages.page(snapshot(), account, "source-a", 1, { cursor: null, limit: 1 });
  assert.ok(first?.nextCursor); assert.deepEqual(first.data, [{ id: "a" }]); assert.doesNotMatch(first.nextCursor, /source-a|saved_local/);
  const params = { cursor: first.nextCursor, limit: 1 };
  assert.equal(pages.page(null, otherAccount, "source-a", 1, params), null);
  assert.equal(pages.page(null, account, "changed", 1, params), null);
  assert.equal(pages.page(null, account, "source-a", 2, params), null);
  assert.equal(pages.page(null, account, "source-a", 1, { ...params, cursor: "forged" }), null);
  assert.equal(pages.page(null, account, "source-a", 1, { ...params, limit: 2 }), null);
  const second = pages.page(null, account, "source-a", 1, params); assert.deepEqual(second?.data, [{ id: "b" }]);
  const third = pages.page(null, account, "source-a", 1, { cursor: second!.nextCursor, limit: 1 }); assert.deepEqual(third, { data: [{ id: "c" }], nextCursor: null });
  pages.clear(); assert.equal(pages.page(null, account, "source-a", 1, params), null);
});

test("snapshot pagination keeps an immutable memory copy and enforces query and aggregate bounds", () => {
  const pages = new NativeProjectSnapshotPagesV1(), rows = snapshot();
  const first = pages.page(rows, account, "source-a", 0, { limit: 1 })!;
  (rows.projects[1] as { id: string }).id = "mutated";
  assert.deepEqual(pages.page(null, account, "source-a", 0, { cursor: first.nextCursor, limit: 1 })!.data, [{ id: "b" }]);
  for (const params of [{ limit: 0 }, { limit: 513 }, { cursor: {} }, { extra: true }]) assert.equal(pages.page(rows, account, "source-a", 0, params), null);
  for (let index = 0; index < 9; index++) assert.ok(pages.page(snapshot(), account, "source-a", 0, { limit: 1 }));
  assert.equal(pages.page(null, account, "source-a", 0, { cursor: first.nextCursor, limit: 1 }), null, "evicted snapshot cannot retain a live cursor");
  assert.equal(pages.page({ ...snapshot(), projects: [{ data: "a".repeat(8 * 1024 * 1024) }] }, account, "source-a", 0, {}), null);
});

test("bound saved reads work with an open WAL writer and preserve all persistent source and ownership bytes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "saved-project-wal-"))); chmodSync(root, 0o700);
  const stateRoot = join(root, "broker"); mkdirSync(stateRoot, { mode: 0o700 });
  const secret = Buffer.alloc(32, 17), raw = ["wal-source", "wal-peer"];
  const accounts = raw.map((value) => `ar_${createHmac("sha256", secret).update(`account-router:v1:${value}`).digest("base64url")}` as OpaqueAccountId);
  const identity = (path: string) => { const stat = lstatSync(path); return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 }; };
  const privateWrite = (path: string, value: unknown) => { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); };
  const sources = accounts.map((opaqueAccountId, index) => {
    const codexHome = join(root, `codex-${index}`), sqliteHome = join(root, `sqlite-${index}`);
    mkdirSync(codexHome, { mode: 0o700 }); mkdirSync(sqliteHome, { mode: 0o700 });
    privateWrite(join(codexHome, "auth.json"), { tokens: { account_id: raw[index], refresh_token: "fixture-only" } });
    return { opaqueAccountId, codexHome, sqliteHome, codexHomeIdentity: identity(codexHome), sqliteHomeIdentity: identity(sqliteHome), authIdentityHmac: nativeHistoryAuthIdentityHmacV1(raw[index]!, secret) };
  });
  const draft: Omit<RouterConfigV3, "fingerprint"> = { schemaVersion: 3, mode: "quota_aware", policy: "quota_aware_v2", generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accounts[1]!, updatedAt: "2026-10-11T12:00:00.000Z",
    accounts: accounts.map((opaqueAccountId, index) => ({ opaqueAccountId, label: `Fixture account ${index}`, included: true, weight: 1, capabilityFingerprint: `sha256:${String(index).repeat(64)}` as `sha256:${string}` })) };
  const config = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  const source = sources[0]!, db = join(source.sqliteHome, "state_5.sqlite"), global = join(source.codexHome, ".codex-global-state.json");
  privateWrite(global, { "local-projects": { "legacy-a": { id: "legacy-a", name: "Tweakers", rootPaths: ["/Users/thomashulihan/Projects/tweakers"], createdAt: 1, updatedAt: 2 } },
    "app-server-project-id-by-legacy-project-id-by-host": { [`local:${source.codexHome}`]: { "legacy-a": "project-a" } }, "pinned-project-ids": ["legacy-a"] });
  privateWrite(join(stateRoot, "native-history-source.v1.json"), signNativeHistorySourceV1({ version: 1, kind: "account-router-native-history-source", mode: "in_place",
    protocolFingerprint: config.protocolFingerprint, accountSetFingerprint: nativeHistoryAccountSetFingerprintV1(accounts), metadataAccountId: accounts[0]!, accounts: sources.slice().sort((left, right) => left.opaqueAccountId < right.opaqueAccountId ? -1 : left.opaqueAccountId > right.opaqueAccountId ? 1 : 0),
    issuedAt: "2026-10-11T12:00:00.000Z" }, secret));
  privateWrite(join(stateRoot, "native-legacy-project-removals.v1.json"), { version: 1, metadataAccountId: accounts[0], removals: {} });
  privateWrite(join(stateRoot, "native-project-links.v1.json"), { version: 1, metadataAccountId: accounts[0], links: [] });
  writeFileSync(db, "", { mode: 0o600, flag: "wx" });
  const emptyDb = lstatSync(db);
  assert.ok(emptyDb.isFile() && !emptyDb.isSymbolicLink() && emptyDb.nlink === 1 && emptyDb.uid === process.getuid?.() && (emptyDb.mode & 0o077) === 0);
  const writer = spawn("/usr/bin/sqlite3", ["-noinit", "-nofollow", "-batch", db], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  try {
    const ready = new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("WAL fixture writer readiness timeout")), 5_000);
      writer.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("writer-ready")) { clearTimeout(timer); resolve(); } });
      writer.stderr.once("data", (chunk: Buffer) => { clearTimeout(timer); reject(new Error(`WAL fixture writer failed: ${chunk.toString("utf8").slice(0, 512)}`)); });
      writer.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    writer.stdin.write(`PRAGMA journal_mode=WAL;
PRAGMA wal_autocheckpoint=0;
CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY,description TEXT NOT NULL,success BOOLEAN NOT NULL,checksum BLOB NOT NULL);
INSERT INTO _sqlx_migrations VALUES(59,'thread attachment reverse lookup',1,X'4297DFFB4FB308F0C665E4D126B7D2A96DB7BE48EB2E13C7E1245A5D95C4DF4E66D64E79AD00FEC26B0910436703090C');
CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,metadata TEXT NOT NULL DEFAULT '{}',position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL);
CREATE TABLE project_roots(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,position INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(project_id,position));
INSERT INTO projects VALUES('project-a','Tweakers','{"custom":"kept"}',0,1700000000123,1700000000456);
INSERT INTO project_roots VALUES('project-a',0,'/Users/thomashulihan/Projects/tweakers');
CREATE TABLE threads(id TEXT PRIMARY KEY,created_at INTEGER,updated_at INTEGER,recency_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,recency_at_ms INTEGER,section_position INTEGER);
INSERT INTO threads VALUES('older',1,20,20,NULL,NULL,NULL,2),('newer',2,10,10,2001,10001,10001,1),('tie',2,10,10,2001,10001,10001,3);
SELECT 'writer-ready';\n`);
    await ready;
    assert.equal(writer.exitCode, null); assert.ok(existsSync(`${db}-wal`)); assert.ok(existsSync(`${db}-shm`));
    for (const path of [db, `${db}-wal`, `${db}-shm`]) chmodSync(path, 0o600);
    const preflight = readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret);
    assert.equal(preflight.state, "ready"); if (preflight.state !== "ready") return;
    const paths = [db, `${db}-wal`, global, ...sources.map((entry) => join(entry.codexHome, "auth.json")),
      join(stateRoot, "native-history-source.v1.json"), join(stateRoot, "native-legacy-project-removals.v1.json"), join(stateRoot, "native-project-links.v1.json")];
    const hashes = () => paths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex"));
    const before = hashes(), shmIdentity = identity(`${db}-shm`);
    // The writer connection stays open; all writes were committed before this
    // measurement, and no command is sent until after the persistent hashes.
    const snapshot = await new NativeProjectSnapshotReaderV1(preflight.binding).read();
    assert.ok(snapshot); assert.equal(snapshot.source, "saved_local");
    const projection = new NativeLegacyProjectsV1(stateRoot, source.codexHome, accounts[0]!).desktopProjection(snapshot.projects,
      { access: "read_only", source: "saved_local", authorityGeneration: 0 });
    assert.ok(projection); assert.equal(projection.values["local-projects"]["legacy-a"]!.createdAt, 1_700_000_000_123);
    assert.deepEqual(projection.values["local-projects"]["legacy-a"]!.rootPaths, ["/Users/thomashulihan/Projects/tweakers"]);
    const reader = new NativeProjectSnapshotReaderV1(preflight.binding);
    const ids = ["older", "newer", "tie", "missing"];
    assert.deepEqual(await reader.readThreadOrder(ids, "created_at", "desc"), ["tie", "newer", "older"]);
    assert.deepEqual(await reader.readThreadOrder(ids, "updated_at", "desc"), ["older", "tie", "newer"]);
    assert.deepEqual(await reader.readThreadOrder(ids, "recency_at", "asc"), ["newer", "tie", "older"]);
    assert.deepEqual(await reader.readThreadOrder(ids, "section_position", "asc"), ["newer", "older", "tie"]);
    assert.equal(await reader.readThreadOrder(ids, "title", "desc"), null);
    assert.deepEqual(hashes(), before, "DB/WAL/global/auth and ownership bytes remain identical");
    assert.deepEqual(identity(`${db}-shm`), shmIdentity, "SHM coordination preserves safe file identity; its bytes are not persistent project data");
    assert.equal(writer.exitCode, null);
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) {
      const closed = new Promise<void>((resolve) => writer.once("close", () => resolve()));
      const timer = setTimeout(() => writer.kill("SIGKILL"), 5_000); writer.stdin.end(); await closed; clearTimeout(timer);
    }
  }
});

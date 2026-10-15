"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeProjectSnapshotPagesV1 = exports.NativeProjectSnapshotReaderV1 = exports.NATIVE_PROJECT_SNAPSHOT_MAX_PROJECTS = exports.NATIVE_PROJECT_SNAPSHOT_MAX_BYTES = void 0;
exports.nativeProjectRpcRowV1 = nativeProjectRpcRowV1;
exports.parseSavedNativeProjectsV1 = parseSavedNativeProjectsV1;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const native_history_1 = require("./native-history");
const types_1 = require("./types");
exports.NATIVE_PROJECT_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
exports.NATIVE_PROJECT_SNAPSHOT_MAX_PROJECTS = 512;
const MAX_ROOTS = 16_384;
const MIGRATION_59_CHECKSUM = "4297DFFB4FB308F0C665E4D126B7D2A96DB7BE48EB2E13C7E1245A5D95C4DF4E66D64E79AD00FEC26B0910436703090C";
/** Native Project RPC timestamps are integer seconds; SQLite/desktop rows keep milliseconds. */
function nativeProjectRpcRowV1(value, source) {
    const row = structuredClone(value);
    if (source !== "saved_local" || !(0, types_1.isPlainRecord)(row))
        return row;
    if (integer(row.createdAt))
        row.createdAt = Math.trunc(row.createdAt / 1000);
    if (integer(row.updatedAt))
        row.updatedAt = Math.trunc(row.updatedAt / 1000);
    return row;
}
// One ordinary WAL-aware read transaction. Never immutable/nolock, a checkpoint,
// an exclusive lock, or a writable project connection. SQLite's shared-memory
// WAL coordination is permitted; project/global-state/auth data is read-only.
const QUERY = `PRAGMA query_only=ON;
PRAGMA trusted_schema=OFF;
BEGIN;
SELECT json_object(
 'tables',(SELECT json_group_array(json_object('name',name,'type',type)) FROM sqlite_master WHERE name IN ('projects','project_roots')),
 'projectColumns',(SELECT json_group_array(json_object('cid',cid,'name',name,'type',type,'notnull',"notnull",'default',dflt_value,'pk',pk,'hidden',hidden)) FROM pragma_table_xinfo('projects')),
 'rootColumns',(SELECT json_group_array(json_object('cid',cid,'name',name,'type',type,'notnull',"notnull",'default',dflt_value,'pk',pk,'hidden',hidden)) FROM pragma_table_xinfo('project_roots')),
 'foreignKeys',(SELECT json_group_array(json_object('id',id,'seq',seq,'table',"table",'from',"from",'to',"to",'onUpdate',on_update,'onDelete',on_delete,'match',"match")) FROM pragma_foreign_key_list('project_roots')),
 'triggers',(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('projects','project_roots')),
 'migrations',(SELECT json_group_array(json_object('version',version,'description',description,'success',success,'checksum',hex(checksum))) FROM _sqlx_migrations),
 'projects',(SELECT json_group_array(json_object('id',id,'name',name,'metadata',metadata,'position',position,'createdAt',created_at_ms,'updatedAt',updated_at_ms)) FROM (SELECT * FROM projects ORDER BY position,id LIMIT 513)),
 'roots',(SELECT json_group_array(json_object('projectId',project_id,'position',position,'path',path)) FROM (SELECT * FROM project_roots ORDER BY project_id,position LIMIT 16385))
);
COMMIT;`;
/** Uses only the signed metadata-account homes; this reader never creates an auth child. */
class NativeProjectSnapshotReaderV1 {
    binding;
    constructor(binding) {
        this.binding = binding;
    }
    fingerprint(requireDatabase = true) {
        try {
            if (!(0, native_history_1.nativeHistoryBindingSafeV1)(this.binding))
                return null;
            const account = this.binding.accounts.find((entry) => entry.opaqueAccountId === this.binding.source.metadataAccountId);
            if (!account)
                return null;
            const db = (0, node_path_1.join)(account.sqliteHome, "state_5.sqlite");
            const globalState = (0, node_path_1.join)(account.codexHome, ".codex-global-state.json");
            const identities = [fileIdentity(db, !requireDatabase), fileIdentity(`${db}-wal`, true), fileIdentity(globalState, true, exports.NATIVE_PROJECT_SNAPSHOT_MAX_BYTES)];
            if (identities.some((identity) => identity === undefined) || fileIdentity(`${db}-shm`, true) === undefined)
                return null;
            return (0, node_crypto_1.createHash)("sha256").update(JSON.stringify([this.binding.sourceDocumentFingerprint, this.binding.extensionDocumentFingerprint, account, identities])).digest("hex");
        }
        catch {
            return null;
        }
    }
    async read() {
        const before = this.fingerprint();
        if (!before)
            return null;
        const account = this.binding.accounts.find((entry) => entry.opaqueAccountId === this.binding.source.metadataAccountId);
        if (!account)
            return null;
        const bytes = await readSqlite((0, node_path_1.join)(account.sqliteHome, "state_5.sqlite"));
        if (!bytes || this.fingerprint() !== before)
            return null;
        try {
            const projects = parseSavedNativeProjectsV1(JSON.parse(bytes));
            return projects ? { account: account.opaqueAccountId, fingerprint: before, projects, source: "saved_local" } : null;
        }
        catch {
            return null;
        }
    }
    async readThreadOrder(ids, sortKey, direction) {
        if (ids.length > MAX_ROOTS || new Set(ids).size !== ids.length || ids.some((id) => !projectId(id))
            || !["created_at", "updated_at", "recency_at", "section_position"].includes(sortKey) || !["asc", "desc"].includes(direction))
            return null;
        const before = this.fingerprint();
        const account = this.binding.accounts.find((entry) => entry.opaqueAccountId === this.binding.source.metadataAccountId);
        if (!before || !account)
            return null;
        if (ids.length === 0)
            return [];
        const members = JSON.stringify(ids).replace(/'/g, "''");
        const column = sortKey === "section_position" ? "section_position" : `COALESCE(${sortKey}_ms,${sortKey}*1000)`;
        const query = `PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;
SELECT json_object('type',(SELECT type FROM sqlite_master WHERE name='threads'),
'ids',(SELECT json_group_array(id) FROM (SELECT id FROM threads WHERE id IN (SELECT value FROM json_each('${members}')) ORDER BY ${column} ${direction},id ${direction} LIMIT 16385)));
COMMIT;`;
        const bytes = await readSqlite((0, node_path_1.join)(account.sqliteHome, "state_5.sqlite"), query);
        if (!bytes || this.fingerprint() !== before)
            return null;
        try {
            const value = JSON.parse(bytes), allowed = new Set(ids);
            if (value?.type !== "table" || !Array.isArray(value.ids) || value.ids.length > MAX_ROOTS
                || new Set(value.ids).size !== value.ids.length || value.ids.some((id) => typeof id !== "string" || !allowed.has(id)))
                return null;
            return value.ids;
        }
        catch {
            return null;
        }
    }
}
exports.NativeProjectSnapshotReaderV1 = NativeProjectSnapshotReaderV1;
function fileIdentity(path, optional, maxBytes) {
    let stat;
    try {
        stat = (0, node_fs_1.lstatSync)(path);
    }
    catch (error) {
        if (optional && error.code === "ENOENT")
            return null;
        return undefined;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)
        || (0, node_fs_1.realpathSync)(path) !== path || (maxBytes !== undefined && stat.size > maxBytes))
        return undefined;
    return [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
}
async function readSqlite(path, query = QUERY) {
    return new Promise((resolvePromise) => {
        // `-init /dev/null` skips ~/.sqliterc like `-noinit`, which older macOS sqlite3 rejects.
        const child = (0, node_child_process_1.spawn)("/usr/bin/sqlite3", ["-readonly", "-init", "/dev/null", "-nofollow", "-batch", "-cmd", ".timeout 1000", path], {
            stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        });
        const chunks = [];
        let total = 0, failed = false, settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            for (const chunk of chunks)
                chunk.fill(0);
            resolvePromise(result);
        };
        const refuse = () => { failed = true; child.kill("SIGKILL"); };
        const timer = setTimeout(refuse, 5_000);
        timer.unref();
        child.stdout.on("data", (chunk) => { total += chunk.length; if (total > exports.NATIVE_PROJECT_SNAPSHOT_MAX_BYTES)
            refuse();
        else
            chunks.push(chunk); });
        child.stderr.on("data", (chunk) => { if (chunk.length)
            refuse(); });
        child.once("error", () => finish(null));
        child.once("close", (code, signal) => finish(!failed && code === 0 && signal === null ? Buffer.concat(chunks).toString("utf8") : null));
        child.stdin.on("error", refuse);
        child.stdin.end(query);
    });
}
const projectColumns = [
    ["id", "TEXT", 0, null, 1], ["name", "TEXT", 1, null, 0], ["metadata", "TEXT", 1, "'{}'", 0],
    ["position", "INTEGER", 1, null, 0], ["created_at_ms", "INTEGER", 1, null, 0], ["updated_at_ms", "INTEGER", 1, null, 0],
];
const rootColumns = [["project_id", "TEXT", 1, null, 1], ["position", "INTEGER", 1, null, 2], ["path", "TEXT", 1, null, 0]];
function columnsMatch(value, expected) {
    return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => (0, types_1.isPlainRecord)(entry)
        && entry.cid === index && entry.hidden === 0 && JSON.stringify([entry.name, entry.type, entry.notnull, entry.default, entry.pk]) === JSON.stringify(expected[index]));
}
/** Exported pure schema seam for fixtures; unsupported migrations/schema fail closed. */
function parseSavedNativeProjectsV1(value) {
    if (!(0, types_1.isPlainRecord)(value) || Buffer.byteLength(JSON.stringify(value)) > exports.NATIVE_PROJECT_SNAPSHOT_MAX_BYTES
        || !Array.isArray(value.tables) || value.tables.length !== 2 || !value.tables.every((entry) => (0, types_1.isPlainRecord)(entry) && entry.type === "table")
        || new Set(value.tables.map((entry) => entry.name)).size !== 2 || !value.tables.some((entry) => entry.name === "projects") || !value.tables.some((entry) => entry.name === "project_roots")
        || !columnsMatch(value.projectColumns, projectColumns) || !columnsMatch(value.rootColumns, rootColumns) || value.triggers !== 0
        || !Array.isArray(value.foreignKeys) || value.foreignKeys.length !== 1
        || JSON.stringify(value.foreignKeys[0]) !== JSON.stringify({ id: 0, seq: 0, table: "projects", from: "project_id", to: "id", onUpdate: "NO ACTION", onDelete: "CASCADE", match: "NONE" })
        || !Array.isArray(value.migrations) || value.migrations.length < 1 || value.migrations.length > 59
        || !value.migrations.every((entry) => (0, types_1.isPlainRecord)(entry) && integer(entry.version) && entry.version >= 1 && entry.version <= 59 && entry.success === 1)
        || new Set(value.migrations.map((entry) => entry.version)).size !== value.migrations.length
        || !value.migrations.some((entry) => entry.version === 59 && entry.description === "thread attachment reverse lookup" && entry.checksum === MIGRATION_59_CHECKSUM)
        || !Array.isArray(value.projects) || value.projects.length > exports.NATIVE_PROJECT_SNAPSHOT_MAX_PROJECTS || !Array.isArray(value.roots) || value.roots.length > MAX_ROOTS)
        return null;
    const projects = new Map();
    for (const entry of value.projects) {
        if (!(0, types_1.isPlainRecord)(entry) || !projectId(entry.id) || projects.has(entry.id) || typeof entry.name !== "string" || !entry.name.length || entry.name.length > 4096 || /[\u0000-\u001f\u007f]/.test(entry.name)
            || !integer(entry.position) || !integer(entry.createdAt) || !integer(entry.updatedAt) || typeof entry.metadata !== "string")
            return null;
        let metadata;
        try {
            metadata = JSON.parse(entry.metadata);
        }
        catch {
            return null;
        }
        if (!(0, types_1.isPlainRecord)(metadata) || !jsonData(metadata, 0))
            return null;
        projects.set(entry.id, { id: entry.id, name: entry.name, metadata, roots: [], createdAt: entry.createdAt, updatedAt: entry.updatedAt });
    }
    const positions = new Set();
    for (const root of value.roots) {
        if (!(0, types_1.isPlainRecord)(root) || !projectId(root.projectId) || !integer(root.position) || typeof root.path !== "string" || !(0, node_path_1.isAbsolute)(root.path)
            || (0, node_path_1.normalize)(root.path) !== root.path || root.path.length > 4096 || /[\u0000-\u001f\u007f]/.test(root.path))
            return null;
        const project = projects.get(root.projectId), key = `${root.projectId}\0${root.position}`;
        if (!project || positions.has(key) || project.roots.length >= 512 || project.roots.some((entry) => entry.path === root.path))
            return null;
        positions.add(key);
        project.roots.push({ path: root.path });
    }
    return [...projects.values()];
}
function integer(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function projectId(value) { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s/\\\u0000-\u001f\u007f]/.test(value) && !["__proto__", "constructor", "prototype"].includes(value); }
function jsonData(value, depth) {
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
        return true;
    if (depth >= 8)
        return false;
    if (Array.isArray(value))
        return value.length <= 512 && value.every((entry) => jsonData(entry, depth + 1));
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).length <= 512 && Object.entries(value).every(([key, entry]) => projectId(key) && jsonData(entry, depth + 1));
}
/** Opaque cursors seal an immutable, bounded, account/source/authority-specific snapshot. */
class NativeProjectSnapshotPagesV1 {
    snapshots = new Map();
    cursors = new Map();
    clear() { this.snapshots.clear(); this.cursors.clear(); }
    page(snapshot, account, fingerprint, generation, params) {
        if (!(0, types_1.isPlainRecord)(params) || Object.keys(params).some((key) => !["cursor", "limit"].includes(key))
            || !(params.cursor === undefined || params.cursor === null || (typeof params.cursor === "string" && params.cursor.length <= 128))
            || !(params.limit === undefined || params.limit === null || (integer(params.limit) && params.limit >= 1 && params.limit <= 512)))
            return null;
        const limit = params.limit === undefined || params.limit === null ? 100 : params.limit;
        for (const [id, entry] of this.snapshots)
            if (entry.expiresAt <= Date.now())
                this.snapshots.delete(id);
        for (const [id, cursor] of this.cursors)
            if (!this.snapshots.has(cursor.snapshotId))
                this.cursors.delete(id);
        let snapshotId, offset = 0;
        if (params.cursor) {
            const cursor = this.cursors.get(params.cursor);
            if (!cursor || cursor.limit !== limit)
                return null;
            snapshotId = cursor.snapshotId;
            offset = cursor.offset;
        }
        else {
            if (!snapshot || snapshot.account !== account || snapshot.fingerprint !== fingerprint || snapshot.projects.length > 512)
                return null;
            const bytes = Buffer.byteLength(JSON.stringify(snapshot));
            if (bytes > exports.NATIVE_PROJECT_SNAPSHOT_MAX_BYTES)
                return null;
            while (this.snapshots.size >= 8 || [...this.snapshots.values()].reduce((total, entry) => total + entry.bytes, 0) + bytes > exports.NATIVE_PROJECT_SNAPSHOT_MAX_BYTES)
                this.snapshots.delete(this.snapshots.keys().next().value);
            snapshotId = (0, node_crypto_1.randomBytes)(24).toString("base64url");
            this.snapshots.set(snapshotId, { snapshot: structuredClone(snapshot), generation, bytes, expiresAt: Date.now() + 5 * 60_000 });
        }
        const entry = this.snapshots.get(snapshotId);
        if (!entry || entry.generation !== generation || entry.snapshot.account !== account || entry.snapshot.fingerprint !== fingerprint)
            return null;
        const data = entry.snapshot.projects.slice(offset, offset + limit).map((row) => nativeProjectRpcRowV1(row, entry.snapshot.source));
        let nextCursor = null;
        if (offset + limit < entry.snapshot.projects.length) {
            nextCursor = (0, node_crypto_1.randomBytes)(24).toString("base64url");
            this.cursors.set(nextCursor, { snapshotId, offset: offset + limit, limit });
            while (this.cursors.size > 128)
                this.cursors.delete(this.cursors.keys().next().value);
        }
        return { data, nextCursor };
    }
}
exports.NativeProjectSnapshotPagesV1 = NativeProjectSnapshotPagesV1;
//# sourceMappingURL=native-project-snapshot.js.map
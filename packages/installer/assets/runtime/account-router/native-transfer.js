"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeTransferCoordinatorV1 = exports.Sqlite3NativeCatalogDbV1 = exports.NATIVE_TRANSFER_MAX_ROLLOUT_BYTES_V1 = exports.NATIVE_CATALOG_MAX_BYTES_V1 = exports.NATIVE_CATALOG_MAX_THREADS_V1 = exports.NATIVE_HISTORY_SCHEMA_FINGERPRINT_V2 = exports.NATIVE_TRANSFER_MINIMUM_RUNTIME_FILE_V2 = exports.NATIVE_CATALOG_JOURNAL_FILE_V2 = exports.NATIVE_CATALOG_FILE_V2 = exports.NATIVE_CATALOG_VERSION_V1 = exports.NATIVE_CATALOG_JOURNAL_FILE_V1 = exports.NATIVE_CATALOG_FILE_V1 = exports.ACCOUNTS_TRANSFER_READER_VERSION = void 0;
exports.inspectNativeTransferCompatibilityV2 = inspectNativeTransferCompatibilityV2;
exports.probeNativeTransferCapabilityV1 = probeNativeTransferCapabilityV1;
exports.readCommittedNativeThreadInventoryV1 = readCommittedNativeThreadInventoryV1;
const native_thread_writer_lease_1 = require("./native-thread-writer-lease");
const native_source_retirement_1 = require("./native-source-retirement");
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_readline_1 = require("node:readline");
const state_store_1 = require("./state-store");
const types_1 = require("./types");
/**
 * This module owns only owner-private native catalog/projection state. It
 * deliberately contains no provider requests, renderer data, profile details,
 * renderer-facing payloads or durable RouterStateStore ownership mutations.
 * V2 journals hold bounded owner-private generation snapshots for recovery.
 */
exports.ACCOUNTS_TRANSFER_READER_VERSION = 2;
exports.NATIVE_CATALOG_FILE_V1 = "native-catalog.v1.json";
exports.NATIVE_CATALOG_JOURNAL_FILE_V1 = "native-catalog.v1.journal.jsonl";
exports.NATIVE_CATALOG_VERSION_V1 = 1;
exports.NATIVE_CATALOG_FILE_V2 = "native-catalog.v2.json";
exports.NATIVE_CATALOG_JOURNAL_FILE_V2 = "native-catalog.v2.journal.jsonl";
exports.NATIVE_TRANSFER_MINIMUM_RUNTIME_FILE_V2 = "native-transfer.minimum-runtime.json";
function inspectNativeTransferCompatibilityV2(marker, candidateVersion) {
    if (marker === null || marker === undefined)
        return { state: Number.isSafeInteger(candidateVersion) && candidateVersion >= 1 ? "compatible" : "incompatible", minimumVersion: 1 };
    const valid = (0, types_1.isPlainRecord)(marker) && exactKeys(marker, ["version", "minimumTransferVersion"])
        && marker.version === 1 && marker.minimumTransferVersion === 2;
    return { state: valid && Number.isSafeInteger(candidateVersion) && candidateVersion >= 2 ? "compatible" : "incompatible", minimumVersion: 2 };
}
// Reviewed native history migrations 1 through 6, including the thread-scoped realtime cleanup trigger.
exports.NATIVE_HISTORY_SCHEMA_FINGERPRINT_V2 = "sha256:d4b0347896267dd6c40b51edef0ca43f51a9a4770a77cf1ac083bfc0951a7bc9";
const HISTORY_TABLES_V2 = ["thread_turns", "thread_items", "thread_history_projection_state", "thread_realtime_items"];
exports.NATIVE_CATALOG_MAX_THREADS_V1 = 16_384;
exports.NATIVE_CATALOG_MAX_BYTES_V1 = 64 * 1024 * 1024;
exports.NATIVE_TRANSFER_MAX_ROLLOUT_BYTES_V1 = 512 * 1024 * 1024;
const SQLITE_TIMEOUT_MS = 5_000;
const SQLITE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SQLITE_PAGE_SIZE = 256;
const MAX_ACCOUNTS = 64;
const MAX_OPERATIONS = 16_384;
const MAX_LOCK_CONVERSIONS = 64;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const COPYABLE_THREAD_COLUMNS = [
    "id",
    "rollout_path",
    "created_at",
    "updated_at",
    "source",
    "model_provider",
    "cwd",
    "title",
    "sandbox_policy",
    "approval_mode",
    "tokens_used",
    "has_user_event",
    "archived",
    "archived_at",
    "git_sha",
    "git_branch",
    "git_origin_url",
    "cli_version",
    "first_user_message",
    "agent_nickname",
    "agent_role",
    "memory_mode",
    "model",
    "reasoning_effort",
    "agent_path",
    "created_at_ms",
    "updated_at_ms",
    "thread_source",
    "preview",
    "recency_at",
    "recency_at_ms",
    "history_mode",
    "name",
];
const COPYABLE_COLUMN_SET = new Set(COPYABLE_THREAD_COLUMNS);
const EXCLUDED_THREAD_COLUMNS = new Set([
    "is_pinned",
    "thread_section_id",
    "section_position",
    "section_entered_at_ms",
    "project_id",
]);
const REQUIRED_THREAD_COLUMNS = new Set([
    "id",
    "rollout_path",
    "created_at",
    "updated_at",
    "source",
    "model_provider",
    "cwd",
    "title",
    "sandbox_policy",
    "approval_mode",
    "history_mode",
    "archived",
]);
// These fields are required by every compatible native schema and remain
// stable across normal recorder activity. Native updates timestamps, tokens,
// previews, titles, and recency in the writer's local SQLite row; treating
// those expected mutations as provenance collisions would wrongly disable a
// healthy same-inode continuation.
const STABLE_ROW_DIGEST_COLUMNS = [
    "id",
    "rollout_path",
    "created_at",
    "source",
    "model_provider",
    "cwd",
    "sandbox_policy",
    "approval_mode",
    "history_mode",
];
/**
 * Production asynchronous adapter. It intentionally invokes the macOS system
 * sqlite client without a shell and never blocks the broker event loop.
 */
class Sqlite3NativeCatalogDbV1 {
    sqlite3Path;
    timeoutMs;
    spawnProcess;
    constructor(options = {}) {
        this.sqlite3Path = options.sqlite3Path ?? "/usr/bin/sqlite3";
        this.timeoutMs = validTimeout(options.timeoutMs) ? options.timeoutMs : SQLITE_TIMEOUT_MS;
        this.spawnProcess = options.spawn ?? node_child_process_1.spawn;
    }
    async inspectSchema(dbPath) {
        assertPrivateSqlitePath(dbPath);
        const output = await this.execute(dbPath, [
            ".bail on",
            ".mode json",
            "SELECT cid, name, type, \"notnull\" AS not_null, dflt_value AS default_value, pk",
            "FROM pragma_table_info('threads') ORDER BY cid;",
        ].join("\n"));
        const raw = parseJsonArray(output);
        const columns = [];
        for (const entry of raw) {
            if (!(0, types_1.isPlainRecord)(entry) || typeof entry.name !== "string" || !safeColumnName(entry.name)
                || typeof entry.type !== "string" || !integer(entry.not_null) || !integer(entry.pk)
                || !(entry.default_value === null || typeof entry.default_value === "string" || typeof entry.default_value === "number")) {
                throw new Error("native sqlite schema output is invalid");
            }
            columns.push({
                name: entry.name,
                affinity: sqliteAffinity(entry.type),
                notNull: entry.not_null !== 0,
                hasDefault: entry.default_value !== null,
                primaryKey: entry.pk !== 0,
            });
        }
        if (columns.length < 1 || columns.length > 256 || new Set(columns.map((column) => column.name)).size !== columns.length) {
            throw new Error("native sqlite threads schema is invalid");
        }
        return { columns };
    }
    async scanEligibleRows(dbPath, after) {
        const schema = await this.inspectSchema(dbPath);
        const copyColumns = selectableColumns(schema);
        if (!schemaReady(schema) || copyColumns.length < REQUIRED_THREAD_COLUMNS.size)
            throw new Error("native sqlite threads schema is unsupported");
        const cursor = after && validCursor(after) ? after : null;
        const selected = copyColumns.map(quoteIdentifier).join(", ");
        const updatedExpression = cursorExpression(copyColumns.includes("updated_at_ms"));
        const cursorSql = cursor
            ? " AND (" + updatedExpression + " > "
                + sqlNumber(cursor.updatedAtMs)
                + " OR (" + updatedExpression + " = "
                + sqlNumber(cursor.updatedAtMs) + " AND id > " + sqlLiteral(cursor.threadId) + "))"
            : "";
        const sql = [
            ".bail on",
            ".mode json",
            "SELECT " + selected + ", " + updatedExpression + " AS __cursor_updated",
            "FROM threads WHERE archived = 0 AND history_mode IN ('paginated', 'legacy')" + cursorSql,
            "ORDER BY __cursor_updated, id LIMIT " + String(SQLITE_PAGE_SIZE + 1) + ";",
        ].join("\n");
        const raw = parseJsonArray(await this.execute(dbPath, sql));
        if (raw.length > SQLITE_PAGE_SIZE + 1)
            throw new Error("native sqlite page is oversized");
        const records = raw.map((entry) => nativeThreadRow(entry, copyColumns, cursorTimestamp(entry)));
        const rows = records.slice(0, SQLITE_PAGE_SIZE);
        const last = rows.at(-1) ?? null;
        const nextCursor = raw.length > SQLITE_PAGE_SIZE && last
            ? { updatedAtMs: cursorTimestamp(raw[rows.length - 1]), threadId: last.threadId }
            : null;
        return { rows, nextCursor };
    }
    async readExact(dbPath, threadId) {
        if (!validNativeThreadId(threadId))
            return null;
        const schema = await this.inspectSchema(dbPath);
        const copyColumns = selectableColumns(schema);
        if (!schemaReady(schema) || copyColumns.length < REQUIRED_THREAD_COLUMNS.size)
            throw new Error("native sqlite threads schema is unsupported");
        const sql = [
            ".bail on",
            ".mode json",
            "SELECT " + copyColumns.map(quoteIdentifier).join(", ") + " FROM threads WHERE id = " + sqlLiteral(threadId) + " LIMIT 2;",
        ].join("\n");
        const rows = parseJsonArray(await this.execute(dbPath, sql));
        if (rows.length > 1)
            throw new Error("native sqlite contains duplicate thread ids");
        return rows.length === 1 ? nativeThreadRow(rows[0], copyColumns) : null;
    }
    async readRetirementRows(stateDb, historyDb, threadId, streamIds) {
        assertPrivateSqlitePath(stateDb);
        assertPrivateSqlitePath(historyDb, true);
        if (!validNativeThreadId(threadId) || (0, node_path_1.dirname)(stateDb) !== (0, node_path_1.dirname)(historyDb))
            throw new Error("retirement sqlite scope invalid");
        const schema = await this.inspectSchema(stateDb);
        if (!schemaReady(schema) || schema.columns.some((column) => column.affinity === "blob"
            || !COPYABLE_COLUMN_SET.has(column.name) && !EXCLUDED_THREAD_COLUMNS.has(column.name)))
            throw new Error("unreviewed retirement threads schema");
        const columns = schema.columns.map((column) => column.name);
        const rowExpression = "(SELECT json_object(" + columns.flatMap((column) => [sqlLiteral(column), quoteIdentifier(column)]).join(",")
            + ") FROM threads WHERE id=" + sqlLiteral(threadId) + ")";
        const result = parseJsonArray(await this.execute(stateDb, ".bail on\n.mode json\nBEGIN;\nSELECT "
            + retirementStateSchemaExpression() + " AS schema_json, " + rowExpression + " AS row_json;\nCOMMIT;"));
        if (result.length !== 1 || !(0, types_1.isPlainRecord)(result[0]) || typeof result[0].schema_json !== "string"
            || result[0].row_json !== null && typeof result[0].row_json !== "string")
            throw new Error("retirement row snapshot invalid");
        const stateSchema = result[0].schema_json;
        const objects = JSON.parse(stateSchema);
        if (!Array.isArray(objects) || objects.some((value) => !(0, types_1.isPlainRecord)(value) || typeof value.type !== "string"
            || typeof value.name !== "string" || typeof value.tbl_name !== "string" || typeof value.sql !== "string" && value.sql !== null
            || value.type === "trigger" && value.tbl_name === "threads" && /\bDELETE\b/i.test(String(value.sql))))
            throw new Error("unreviewed retirement delete trigger");
        const row = result[0].row_json === null ? null : JSON.parse(result[0].row_json);
        if (row !== null && (!(0, types_1.isPlainRecord)(row) || !exactKeys(row, columns) || !Object.values(row).every(nativeSqlValue)
            || row.id !== threadId || row.history_mode !== "paginated"))
            throw new Error("retirement requires an exact paginated row");
        return { stateSchema, row: row, history: await this.readHistorySnapshot(historyDb, streamIds) };
    }
    async compareAndDeleteRetirementRows(stateDb, historyDb, threadId, streamIds, expected) {
        const current = await this.readRetirementRows(stateDb, historyDb, threadId, streamIds);
        if (!expected.row || current.stateSchema !== expected.stateSchema || current.history.schema !== expected.history.schema
            || current.row !== null && canonicalJson(current.row) !== canonicalJson(expected.row)
            || !Object.values(current.history.rows).every((rows) => rows.length === 0) && canonicalJson(current.history) !== canonicalJson(expected.history)) {
            throw new Error("retirement rows changed");
        }
        const historySchema = JSON.parse(expected.history.schema);
        const selected = "thread_id IN (" + streamIds.map(sqlLiteral).join(",") + ")";
        const exactRow = Object.entries(expected.row).map(([column, value]) => quoteIdentifier(column) + " IS " + sqlValue(value)).join(" AND ");
        const rowCount = "(SELECT count(*) FROM threads WHERE id=" + sqlLiteral(threadId) + ")";
        const guards = [
            retirementStateSchemaExpression() + "=" + sqlLiteral(expected.stateSchema),
            "(" + rowCount + "=0 OR (" + rowCount + "=1 AND EXISTS(SELECT 1 FROM threads WHERE " + exactRow + ")))",
            "(SELECT count(*) FROM retired_history.sqlite_master WHERE name NOT LIKE 'sqlite_%')=" + String(historySchema.schema.length),
            ...historySchema.schema.map((value) => "EXISTS(SELECT 1 FROM retired_history.sqlite_master WHERE name=" + sqlLiteral(value.name)
                + " AND sql IS " + sqlValue(value.sql) + ")"),
            "(SELECT count(*) FROM retired_history._sqlx_migrations)=" + String(historySchema.migrations.length),
            ...historySchema.migrations.map((value) => "EXISTS(SELECT 1 FROM retired_history._sqlx_migrations WHERE version=" + sqlValue(value.version)
                + " AND hex(checksum)=" + sqlLiteral(value.checksum) + " AND success=" + sqlValue(value.success) + ")"),
        ];
        const emptyHistory = HISTORY_TABLES_V2.map((table) => "(SELECT count(*) FROM retired_history." + quoteIdentifier(table) + " WHERE " + selected + ")=0").join(" AND ");
        const exactHistory = [];
        for (const table of HISTORY_TABLES_V2) {
            const rows = expected.history.rows[table] ?? [];
            exactHistory.push("(SELECT count(*) FROM retired_history." + quoteIdentifier(table) + " WHERE " + selected + ")=" + String(rows.length));
            for (const row of rows) {
                if (!streamIds.includes(String(row.thread_id)) || !Object.keys(row).every(safeColumnName))
                    throw new Error("retirement history escaped selected streams");
                exactHistory.push("EXISTS(SELECT 1 FROM retired_history." + quoteIdentifier(table) + " WHERE "
                    + Object.entries(row).map(([column, value]) => quoteIdentifier(column) + " IS " + sqlValue(value)).join(" AND ") + ")");
            }
        }
        guards.push("((" + emptyHistory + ") OR (" + exactHistory.join(" AND ") + "))");
        const script = [
            ".bail on", "PRAGMA busy_timeout=1000;", "PRAGMA foreign_keys=OFF;",
            "ATTACH DATABASE " + sqlLiteral(historyDb) + " AS retired_history;", "BEGIN IMMEDIATE;",
            "CREATE TEMP TABLE retirement_guard(ok INTEGER NOT NULL CHECK(ok=1));",
            ...guards.map((guard) => "INSERT INTO retirement_guard VALUES(CASE WHEN " + guard + " THEN 1 ELSE 0 END);"),
            "DELETE FROM threads WHERE id=" + sqlLiteral(threadId) + ";",
            ...HISTORY_TABLES_V2.map((table) => "DELETE FROM retired_history." + quoteIdentifier(table) + " WHERE " + selected + ";"),
            "COMMIT;", "DETACH DATABASE retired_history;",
        ].join("\n");
        await this.execute(stateDb, script);
    }
    async insertProjection(input) {
        if (!validProjectionInput(input))
            return "conflict";
        assertPrivateSqlitePath(input.sourceDbPath);
        assertPrivateSqlitePath(input.targetDbPath);
        const targetSchema = await this.inspectSchema(input.targetDbPath);
        if (!schemaReady(targetSchema))
            return "conflict";
        const targetColumns = new Map(targetSchema.columns.map((column) => [column.name, column]));
        const copyColumns = COPYABLE_THREAD_COLUMNS.filter((column) => {
            const schemaColumn = targetColumns.get(column);
            return Boolean(schemaColumn) && Object.prototype.hasOwnProperty.call(input.source.values, column);
        });
        const localValues = input.targetLocalValues ?? {};
        if (!(0, types_1.isPlainRecord)(localValues) || !Object.entries(localValues).every(([column, value]) => EXCLUDED_THREAD_COLUMNS.has(column)
            && nativeSqlValue(value) && targetColumns.has(column) && valueFitsAffinity(value, targetColumns.get(column).affinity)))
            return "conflict";
        copyColumns.push(...Object.keys(localValues));
        if (!REQUIRED_THREAD_COLUMNS.size || REQUIRED_THREAD_COLUMNS.size > copyColumns.length)
            return "conflict";
        if (![...REQUIRED_THREAD_COLUMNS].every((column) => copyColumns.includes(column)))
            return "conflict";
        if (!copyColumns.every((column) => valueFitsAffinity(Object.hasOwn(localValues, column) ? localValues[column] : input.source.values[column], targetColumns.get(column).affinity)))
            return "conflict";
        for (const column of targetSchema.columns) {
            if (!copyColumns.includes(column.name) && column.notNull && !column.hasDefault) {
                return "conflict";
            }
        }
        const values = copyColumns.map((column) => column === "rollout_path" ? input.targetPath : Object.hasOwn(localValues, column) ? localValues[column] : input.source.values[column]);
        const insertColumns = copyColumns.map(quoteIdentifier).join(", ");
        const insertValues = values.map(sqlValue).join(", ");
        const selected = copyColumns.map(quoteIdentifier).join(", ");
        const expected = Object.fromEntries(copyColumns.map((column, index) => [column, values[index]]));
        const referenceGuards = [];
        for (const [column, table] of [["project_id", "projects"], ["thread_section_id", "thread_sections"]]) {
            const value = localValues[column];
            if (value !== undefined && value !== null) {
                if (typeof value !== "string" || !value)
                    return "conflict";
                referenceGuards.push("INSERT INTO projection_local_guard VALUES(CASE WHEN (SELECT count(*) FROM " + quoteIdentifier(table)
                    + " WHERE id=" + sqlLiteral(value) + ")=1 THEN 1 ELSE 0 END);");
            }
        }
        const sql = [
            ".bail on",
            ".once /dev/null",
            "PRAGMA busy_timeout=5000;",
            "BEGIN IMMEDIATE;",
            ...(referenceGuards.length ? ["CREATE TEMP TABLE projection_local_guard(ok INTEGER NOT NULL CHECK(ok=1));", ...referenceGuards] : []),
            "INSERT INTO threads (" + insertColumns + ")",
            "SELECT " + insertValues + " WHERE NOT EXISTS (SELECT 1 FROM threads WHERE id = " + sqlLiteral(input.source.threadId) + ");",
            ".mode json",
            "SELECT changes() AS __changes, " + selected + " FROM threads WHERE id = " + sqlLiteral(input.source.threadId) + " LIMIT 2;",
            "COMMIT;",
        ].join("\n");
        const rows = parseJsonArray(await this.execute(input.targetDbPath, sql));
        if (rows.length !== 1 || !(0, types_1.isPlainRecord)(rows[0]) || !integer(rows[0].__changes))
            return "conflict";
        const target = nativeThreadRow(rows[0], copyColumns);
        if (!projectionRowExact(target, expected, copyColumns))
            return "conflict";
        return rows[0].__changes === 1 ? "inserted" : "already_exact";
    }
    async readHistorySnapshot(dbPath, streamIds) {
        assertPrivateSqlitePath(dbPath, true);
        if (!streamIds.length || streamIds.length > 1024 || !streamIds.every(validNativeThreadId))
            throw new Error("invalid history streams");
        const filter = streamIds.map(sqlLiteral).join(",");
        // One SQLite read transaction binds the four projections and migration ledger.
        const schemas = parseJsonArray(await this.execute(dbPath, ".mode json\nSELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name;"));
        const columns = new Map();
        for (const table of HISTORY_TABLES_V2) {
            const info = parseJsonArray(await this.execute(dbPath, ".mode json\nSELECT name, type FROM pragma_table_info(" + sqlLiteral(table) + ") ORDER BY cid;"));
            if (!info.length || info.length > 128 || !info.every((c) => (0, types_1.isPlainRecord)(c) && typeof c.name === "string" && safeColumnName(c.name) && typeof c.type === "string" && sqliteAffinity(c.type) !== "blob"))
                throw new Error("unsupported history schema");
            const names = info.map((c) => c.name);
            if (!names.includes("thread_id"))
                throw new Error("history thread key missing");
            columns.set(table, names);
        }
        const pairs = HISTORY_TABLES_V2.map((table) => sqlLiteral(table) + ", (SELECT json_group_array(json_object(" + columns.get(table).flatMap((c) => [sqlLiteral(c), quoteIdentifier(c)]).join(",") + ")) FROM (SELECT * FROM " + quoteIdentifier(table) + " WHERE thread_id IN (" + filter + ") ORDER BY " + columns.get(table).map(quoteIdentifier).join(",") + "))");
        const migration = schemas.some((v) => (0, types_1.isPlainRecord)(v) && v.name === "_sqlx_migrations")
            ? "SELECT json_group_array(json_object('version',version,'checksum',hex(checksum),'success',success)) FROM (SELECT * FROM _sqlx_migrations ORDER BY version)" : "SELECT '[]'";
        const result = parseJsonArray(await this.execute(dbPath, ".bail on\n.mode json\nBEGIN;\nSELECT json_object(" + pairs.join(",") + ") AS rows, (" + migration + ") AS migrations;\nCOMMIT;"));
        if (result.length !== 1 || !(0, types_1.isPlainRecord)(result[0]) || typeof result[0].rows !== "string")
            throw new Error("history snapshot invalid");
        if (typeof result[0].migrations !== "string")
            throw new Error("history migrations invalid");
        const schema = canonicalJson({ schema: schemas, migrations: JSON.parse(result[0].migrations) });
        if ("sha256:" + (0, node_crypto_1.createHash)("sha256").update(schema).digest("hex") !== exports.NATIVE_HISTORY_SCHEMA_FINGERPRINT_V2)
            throw new Error("unreviewed native history schema");
        return { schema, rows: JSON.parse(result[0].rows) };
    }
    async replaceHistorySnapshot(dbPath, snapshot, streamIds) {
        const before = await this.readHistorySnapshot(dbPath, streamIds);
        if (before.schema !== snapshot.schema)
            throw new Error("history schema or migration mismatch");
        const statements = [".bail on", "PRAGMA busy_timeout=1000;", "BEGIN IMMEDIATE;"];
        for (const table of HISTORY_TABLES_V2) {
            statements.push("DELETE FROM " + quoteIdentifier(table) + " WHERE thread_id IN (" + streamIds.map(sqlLiteral).join(",") + ");");
            for (const row of snapshot.rows[table] ?? []) {
                if (!streamIds.includes(String(row.thread_id)))
                    throw new Error("history snapshot escaped thread scope");
                const keys = Object.keys(row);
                if (!keys.every(safeColumnName))
                    throw new Error("history column invalid");
                statements.push("INSERT INTO " + quoteIdentifier(table) + " (" + keys.map(quoteIdentifier).join(",") + ") VALUES (" + keys.map((key) => sqlValue(row[key])).join(",") + ");");
            }
        }
        statements.push("COMMIT;");
        await this.execute(dbPath, statements.join("\n"));
    }
    async refreshProjection(input) {
        const existing = await this.readExact(input.targetDbPath, input.source.threadId);
        if (!existing) {
            if (await this.insertProjection(input) === "conflict")
                throw new Error("projection insert conflict");
            return;
        }
        const schema = await this.inspectSchema(input.targetDbPath);
        const columns = selectableColumns(schema).filter((column) => column !== "id" && Object.hasOwn(input.source.values, column));
        await this.execute(input.targetDbPath, ".bail on\nPRAGMA busy_timeout=1000;\nBEGIN IMMEDIATE;\nUPDATE threads SET " + columns.map((column) => quoteIdentifier(column) + " = " + sqlValue(column === "rollout_path" ? input.targetPath : input.source.values[column])).join(",") + " WHERE id = " + sqlLiteral(input.source.threadId) + ";\nCOMMIT;");
    }
    execute(dbPath, script) {
        return new Promise((resolvePromise, rejectPromise) => {
            let child;
            let settled = false;
            let timer;
            let stdout = Buffer.alloc(0);
            let stderr = Buffer.alloc(0);
            const settle = (callback) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                callback();
            };
            try {
                child = this.spawnProcess(this.sqlite3Path, ["-bail", dbPath], {
                    shell: false,
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"],
                });
            }
            catch {
                rejectPromise(new Error("native sqlite spawn failed"));
                return;
            }
            const append = (current, chunk) => {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if (current.byteLength + bytes.byteLength > SQLITE_MAX_OUTPUT_BYTES)
                    return null;
                return Buffer.concat([current, bytes]);
            };
            child.stdout?.on("data", (chunk) => {
                const next = append(stdout, chunk);
                if (!next) {
                    try {
                        child.kill("SIGKILL");
                    }
                    catch { /* bounded child cleanup */ }
                    settle(() => rejectPromise(new Error("native sqlite stdout exceeded limit")));
                    return;
                }
                stdout = next;
            });
            child.stderr?.on("data", (chunk) => {
                const next = append(stderr, chunk);
                if (!next) {
                    try {
                        child.kill("SIGKILL");
                    }
                    catch { /* bounded child cleanup */ }
                    settle(() => rejectPromise(new Error("native sqlite stderr exceeded limit")));
                    return;
                }
                stderr = next;
            });
            child.once("error", () => settle(() => rejectPromise(new Error("native sqlite spawn failed"))));
            child.once("close", (code, signal) => {
                if (code !== 0 || signal || stderr.byteLength > 0) {
                    settle(() => rejectPromise(new Error(/database is locked|database table is locked/i.test(stderr.toString("utf8")) ? "native sqlite database is locked" : "native sqlite operation failed")));
                    return;
                }
                settle(() => resolvePromise(stdout.toString("utf8")));
            });
            timer = setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                }
                catch { /* bounded child cleanup */ }
                settle(() => rejectPromise(new Error("native sqlite operation timed out")));
            }, this.timeoutMs);
            if (!child.stdin) {
                try {
                    child.kill("SIGKILL");
                }
                catch { /* bounded child cleanup */ }
                settle(() => rejectPromise(new Error("native sqlite stdin unavailable")));
                return;
            }
            child.stdin.end(script + "\n");
        });
    }
}
exports.Sqlite3NativeCatalogDbV1 = Sqlite3NativeCatalogDbV1;
function validTimeout(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 30_000;
}
function assertPrivateSqlitePath(path, history = false) {
    if (!canonicalAbsolutePath(path) || (0, node_path_1.basename)(path) !== (history ? "thread_history_1.sqlite" : "state_5.sqlite") || !nativeAccountDirectoryIdentity((0, node_path_1.dirname)(path))) {
        throw new Error("native sqlite path is unsafe");
    }
    const stat = (0, node_fs_1.lstatSync)(path);
    const mode = stat.mode & 0o777;
    // Codex's native SQLite store is 0644 but it is directly below a sealed
    // CODEX_SQLITE_HOME. Do not extend that compatibility exception to other
    // files or directories.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
        || (mode !== PRIVATE_FILE_MODE && mode !== 0o644) || (mode & 0o022) !== 0
        || !safeIdentity(stat.dev, stat.ino)) {
        throw new Error("native sqlite path is unsafe");
    }
}
function parseJsonArray(value) {
    if (Buffer.byteLength(value, "utf8") > SQLITE_MAX_OUTPUT_BYTES)
        throw new Error("native sqlite output exceeded limit");
    const parsed = value.trim() === "" ? [] : JSON.parse(value);
    if (!Array.isArray(parsed))
        throw new Error("native sqlite output is not an array");
    return parsed;
}
function nativeThreadRow(value, copyColumns, cursorUpdatedAtMs) {
    if (!(0, types_1.isPlainRecord)(value))
        throw new Error("native sqlite row is invalid");
    const values = {};
    for (const column of copyColumns) {
        const item = value[column];
        if (!nativeSqlValue(item))
            throw new Error("native sqlite value is invalid");
        values[column] = item;
    }
    const threadId = values.id;
    const rolloutPath = values.rollout_path;
    const historyMode = values.history_mode;
    const archived = values.archived;
    const updatedAt = values.updated_at;
    const updatedAtMs = values.updated_at_ms;
    if (!validNativeThreadId(threadId) || !canonicalAbsolutePath(rolloutPath)
        || typeof historyMode !== "string" || typeof archived !== "number" || !nativeSqlValue(updatedAt)
        || !(updatedAtMs === undefined || updatedAtMs === null || typeof updatedAtMs === "number")
        || (cursorUpdatedAtMs !== undefined && !integer(cursorUpdatedAtMs))) {
        throw new Error("native sqlite thread row is invalid");
    }
    return {
        threadId,
        rolloutPath,
        historyMode,
        archived,
        updatedAt,
        updatedAtMs: typeof updatedAtMs === "number" ? updatedAtMs : cursorUpdatedAtMs ?? null,
        values,
    };
}
function cursorTimestamp(value) {
    if (!(0, types_1.isPlainRecord)(value) || !integer(value.__cursor_updated))
        throw new Error("native sqlite cursor is invalid");
    return value.__cursor_updated;
}
function cursorExpression(hasUpdatedAtMs) {
    const fallback = "CASE WHEN typeof(updated_at) IN ('integer','real') THEN CAST(updated_at * 1000 AS INTEGER) ELSE CAST(strftime('%s', updated_at) AS INTEGER) * 1000 END";
    return hasUpdatedAtMs ? "COALESCE(updated_at_ms, " + fallback + ")" : fallback;
}
function selectableColumns(schema) {
    return schema.columns
        .map((column) => column.name)
        .filter((name) => COPYABLE_COLUMN_SET.has(name));
}
function schemaReady(schema) {
    if (!Array.isArray(schema.columns) || schema.columns.length < 1 || schema.columns.length > 256)
        return false;
    const columns = new Map();
    for (const column of schema.columns) {
        if (!validSchemaColumn(column) || columns.has(column.name))
            return false;
        columns.set(column.name, column);
    }
    for (const required of REQUIRED_THREAD_COLUMNS) {
        const column = columns.get(required);
        if (!column || !compatibleRequiredAffinity(required, column.affinity))
            return false;
    }
    for (const column of schema.columns) {
        if (!COPYABLE_COLUMN_SET.has(column.name) && !EXCLUDED_THREAD_COLUMNS.has(column.name)
            && column.notNull && !column.hasDefault)
            return false;
    }
    return true;
}
function validSchemaColumn(value) {
    return (0, types_1.isPlainRecord)(value) && safeColumnName(value.name)
        && (value.affinity === "integer" || value.affinity === "text" || value.affinity === "real" || value.affinity === "blob" || value.affinity === "numeric")
        && typeof value.notNull === "boolean" && typeof value.hasDefault === "boolean" && typeof value.primaryKey === "boolean";
}
function compatibleRequiredAffinity(name, affinity) {
    if (name === "archived")
        return affinity === "integer" || affinity === "numeric";
    if (name === "created_at" || name === "updated_at") {
        return affinity === "text" || affinity === "integer" || affinity === "numeric" || affinity === "real";
    }
    return affinity === "text";
}
function sqliteAffinity(type) {
    const normalized = type.trim().toUpperCase();
    if (normalized.includes("INT"))
        return "integer";
    if (normalized.includes("CHAR") || normalized.includes("CLOB") || normalized.includes("TEXT"))
        return "text";
    if (normalized.includes("BLOB") || normalized.length === 0)
        return "blob";
    if (normalized.includes("REAL") || normalized.includes("FLOA") || normalized.includes("DOUB"))
        return "real";
    return "numeric";
}
function safeColumnName(value) {
    return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
}
function quoteIdentifier(value) {
    if (!safeColumnName(value))
        throw new Error("unsafe sqlite identifier");
    return "\"" + value + "\"";
}
function sqlLiteral(value) {
    if (value.includes("\0"))
        throw new Error("unsafe sqlite literal");
    return "'" + value.replaceAll("'", "''") + "'";
}
function sqlNumber(value) {
    if (!Number.isSafeInteger(value))
        throw new Error("unsafe sqlite number");
    return String(value);
}
function sqlValue(value) {
    if (value === null)
        return "NULL";
    if (typeof value === "string")
        return sqlLiteral(value);
    if (typeof value === "boolean")
        return value ? "1" : "0";
    if (!Number.isFinite(value))
        throw new Error("unsafe sqlite number");
    return String(value);
}
function retirementStateSchemaExpression() {
    return "(SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name))";
}
function nativeSqlValue(value) {
    return value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value));
}
function integer(value) {
    return typeof value === "number" && Number.isSafeInteger(value);
}
function valueFitsAffinity(value, affinity) {
    if (value === null)
        return true;
    if (affinity === "text")
        return typeof value === "string";
    if (affinity === "integer")
        return typeof value === "number" || typeof value === "boolean";
    if (affinity === "real" || affinity === "numeric")
        return typeof value === "number" || typeof value === "boolean" || typeof value === "string";
    return false;
}
function validCursor(value) {
    return Number.isSafeInteger(value.updatedAtMs) && validNativeThreadId(value.threadId);
}
function validProjectionInput(value) {
    return (0, types_1.isPlainRecord)(value) && canonicalAbsolutePath(value.sourceDbPath) && canonicalAbsolutePath(value.targetDbPath)
        && validNativeThreadRow(value.source) && canonicalAbsolutePath(value.targetPath);
}
function validNativeThreadRow(value) {
    return (0, types_1.isPlainRecord)(value) && validNativeThreadId(value.threadId) && canonicalAbsolutePath(value.rolloutPath)
        && typeof value.historyMode === "string" && typeof value.archived === "number" && nativeSqlValue(value.updatedAt)
        && (value.updatedAtMs === null || typeof value.updatedAtMs === "number") && (0, types_1.isPlainRecord)(value.values);
}
function projectedValues(source, targetPath, columns) {
    const values = {};
    for (const column of columns)
        values[column] = column === "rollout_path" ? targetPath : source.values[column];
    return values;
}
function projectionRowExact(row, expected, columns) {
    return columns.every((column) => sameSqlValue(row.values[column], expected[column]));
}
function sameSqlValue(left, right) {
    return left === right || (typeof left === "number" && typeof right === "number" && Number.isNaN(left) && Number.isNaN(right));
}
function canonicalAbsolutePath(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0")
        && (0, node_path_1.isAbsolute)(value) && (0, node_path_1.resolve)(value) === value;
}
function validNativeThreadId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 512
        && !/[\\/\u0000-\u001f\u007f]/.test(value);
}
function validOperationId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 256
        && !/[\u0000-\u001f\u007f]/.test(value);
}
class NativeTransferCoordinatorV1 {
    options;
    retirements;
    retirementInFlight = new Set();
    preparationLeases = new Map();
    resumedGenerationProofs = new Set();
    capability = null;
    capabilityInFlight = null;
    document;
    accounts = new Map();
    accountHomeIdentities = new Map();
    accountIds;
    now;
    constructor(options) {
        this.options = options;
        if (!canonicalAbsolutePath(options.stateRoot) || !(0, types_1.isOpaqueAccountId)(options.primaryAccountId)
            || !Array.isArray(options.accounts) || options.accounts.length < 2 || options.accounts.length > MAX_ACCOUNTS
            || typeof options.bindingPreflight !== "function" || typeof options.writerCensus !== "function"
            || typeof options.capabilityProbe !== "function") {
            throw new Error("invalid native transfer coordinator options");
        }
        const usedHomes = new Set();
        for (const account of options.accounts) {
            if (!validAccount(account) || this.accounts.has(account.accountId))
                throw new Error("invalid native transfer account");
            const identities = accountHomeIdentities(account);
            if (!identities || usedHomes.has(account.codexHome) || usedHomes.has(account.sqliteHome)) {
                throw new Error("native transfer account homes are invalid");
            }
            usedHomes.add(account.codexHome);
            usedHomes.add(account.sqliteHome);
            this.accounts.set(account.accountId, { ...account });
            this.accountHomeIdentities.set(account.accountId, identities);
        }
        if (!this.accounts.has(options.primaryAccountId))
            throw new Error("native transfer primary account is unavailable");
        this.accountIds = new Set(this.accounts.keys());
        this.now = options.now ?? (() => new Date());
        assertPrivateDirectory(options.stateRoot);
        this.document = this.loadDocument();
        this.retirements = new native_source_retirement_1.NativeSourceRetirementStoreV2(options.stateRoot, () => [...this.accounts.values()], options.db);
    }
    /**
     * The runtime must call this before it enables native transfer. A missing or
     * failed real probe is a closed unsupported state, never a version guess.
     */
    async probeCapability() {
        if (this.capability)
            return this.capability;
        if (this.capabilityInFlight)
            return this.capabilityInFlight;
        this.capabilityInFlight = Promise.resolve()
            .then(() => this.options.capabilityProbe())
            .then((value) => validCapability(value) ? value : unsupportedCapability("probe_failed"))
            .catch(() => unsupportedCapability("probe_failed"))
            .then((value) => {
            this.capability = value;
            return value;
        })
            .finally(() => { this.capabilityInFlight = null; });
        return this.capabilityInFlight;
    }
    /**
     * Adds enrolled account homes without discarding durable catalog state or
     * remote-controller ownership. Existing members, paths, and pinned home
     * inodes must remain exact; removal and replacement are deliberately not a
     * supported runtime operation.
     */
    updateAccounts(accounts) {
        if (!Array.isArray(accounts) || accounts.length < this.accounts.size || accounts.length > MAX_ACCOUNTS) {
            return { state: "unavailable", reason: "account_set_invalid" };
        }
        let bindingValid = false;
        try {
            bindingValid = this.options.bindingPreflight() === true;
        }
        catch {
            bindingValid = false;
        }
        if (!bindingValid)
            return { state: "unavailable", reason: "native_history_binding_invalid" };
        const nextAccounts = new Map();
        const nextIdentities = new Map();
        const usedHomes = new Set();
        for (const account of accounts) {
            if (!validAccount(account) || nextAccounts.has(account.accountId)
                || usedHomes.has(account.codexHome) || usedHomes.has(account.sqliteHome)) {
                return { state: "unavailable", reason: "account_set_invalid" };
            }
            const identities = accountHomeIdentities(account);
            if (!identities)
                return { state: "unavailable", reason: "account_home_invalid" };
            usedHomes.add(account.codexHome);
            usedHomes.add(account.sqliteHome);
            nextAccounts.set(account.accountId, { ...account });
            nextIdentities.set(account.accountId, identities);
        }
        if (!nextAccounts.has(this.options.primaryAccountId))
            return { state: "unavailable", reason: "primary_account_missing" };
        for (const [accountId, existing] of this.accounts) {
            const replacement = nextAccounts.get(accountId);
            const remembered = this.accountHomeIdentities.get(accountId);
            const observed = replacement ? nextIdentities.get(accountId) : null;
            if (!replacement || !remembered || !observed || replacement.codexHome !== existing.codexHome
                || replacement.sqliteHome !== existing.sqliteHome
                || !sameIdentity(remembered.codexHome, observed.codexHome)
                || !sameIdentity(remembered.sqliteHome, observed.sqliteHome)) {
                return { state: "collision", reason: "account_home_drift" };
            }
        }
        const nextIds = new Set(nextAccounts.keys());
        if (!validDocument(this.document, nextIds))
            return { state: "collision", reason: "native_catalog_account_drift" };
        const addedAccountIds = [...nextAccounts.keys()].filter((accountId) => !this.accounts.has(accountId));
        this.accounts.clear();
        this.accountHomeIdentities.clear();
        for (const [accountId, account] of nextAccounts) {
            this.accounts.set(accountId, account);
            this.accountHomeIdentities.set(accountId, nextIdentities.get(accountId));
        }
        this.accountIds = nextIds;
        return { state: "ready", addedAccountIds };
    }
    /**
     * Exact read-only validation. It never creates or converts a lock directory.
     */
    preflightSharedWriterLocks() {
        const base = this.basePreflight();
        if (base.state !== "ready")
            return base;
        const primary = this.primaryAccount();
        const primaryPath = writerLockPath(primary);
        const primaryIdentity = nativeWriterLockDirectoryIdentity(primary.codexHome, primaryPath);
        if (!primaryIdentity) {
            if (!(0, node_fs_1.existsSync)(primaryPath))
                return unavailable("writer_lock_missing");
            return collision("writer_lock_primary_invalid");
        }
        for (const account of this.secondaryAccounts()) {
            const secondaryPath = writerLockPath(account);
            let stat;
            try {
                stat = (0, node_fs_1.lstatSync)(secondaryPath);
            }
            catch (error) {
                if (error.code === "ENOENT")
                    return unavailable("writer_lock_missing");
                return unavailable("writer_lock_unreadable");
            }
            if (stat.isDirectory() && !stat.isSymbolicLink())
                return busy("writer_lock_conversion_required");
            if (!stat.isSymbolicLink())
                return collision("writer_lock_projection_invalid");
            if (!exactWriterLockSymlink(secondaryPath, primaryPath, primaryIdentity))
                return collision("writer_lock_projection_drift");
        }
        return { state: "ready", sharedWriterLockPath: primaryPath, identity: primaryIdentity };
    }
    /**
     * Runtime-safe provisioning. Existing secondary directories are never
     * converted here; activation must use the explicit offline method below.
     */
    provisionSharedWriterLocks() {
        const base = this.basePreflight(true);
        if (base.state !== "ready")
            return base;
        const primary = this.primaryAccount();
        const primaryPath = writerLockPath(primary);
        const primaryIdentity = this.ensurePrimaryWriterLock(primaryPath);
        if (!primaryIdentity)
            return collision("writer_lock_primary_invalid");
        // Scan every secondary before changing any absent path. A real directory
        // means activation has a pre-existing lock namespace and needs the
        // explicitly gated offline conversion route.
        const absent = [];
        for (const account of this.secondaryAccounts()) {
            const secondaryPath = writerLockPath(account);
            try {
                const stat = (0, node_fs_1.lstatSync)(secondaryPath);
                if (stat.isDirectory() && !stat.isSymbolicLink())
                    return busy("writer_lock_conversion_required");
                if (!stat.isSymbolicLink())
                    return collision("writer_lock_projection_invalid");
                if (!exactWriterLockSymlink(secondaryPath, primaryPath, primaryIdentity))
                    return collision("writer_lock_projection_drift");
            }
            catch (error) {
                if (error.code === "ENOENT")
                    absent.push(account);
                else
                    return unavailable("writer_lock_unreadable");
            }
        }
        for (const account of absent) {
            const secondaryPath = writerLockPath(account);
            this.recordLockConversion(account.accountId, null, primaryIdentity, "intent");
            try {
                publishWriterLockSymlink(secondaryPath, primaryPath);
                if (!exactWriterLockSymlink(secondaryPath, primaryPath, primaryIdentity)) {
                    throw new Error("writer lock projection mismatch");
                }
                this.recordLockConversion(account.accountId, null, primaryIdentity, "published");
            }
            catch {
                this.recordLockConversion(account.accountId, null, primaryIdentity, "collision");
                return collision("writer_lock_projection_publish_failed");
            }
        }
        return this.preflightSharedWriterLocks();
    }
    /**
     * Activation-only conversion. The caller must supply an independent offline
     * proof in addition to the signed-binding and process-census checks.
     */
    convertOfflineWriterLockDirectory(accountId, options) {
        return this.convertWriterLockDirectory(accountId, options, false);
    }
    /**
     * Only the selected idle secondary is changed. The primary namespace must
     * already exist and remain the same directory while its native app runs.
     * The caller independently proves the secondary app and writers are absent.
     */
    convertIdleSecondaryWriterLockDirectory(accountId, options) {
        return this.convertWriterLockDirectory(accountId, options, true);
    }
    convertWriterLockDirectory(accountId, options, secondaryOnly) {
        if (!(0, types_1.isOpaqueAccountId)(accountId) || accountId === this.options.primaryAccountId || typeof options?.offlinePreflight !== "function") {
            return unavailable("offline_conversion_input_invalid");
        }
        const base = this.basePreflight(!secondaryOnly);
        if (base.state !== "ready")
            return base;
        let offline = false;
        try {
            offline = options.offlinePreflight() === true;
        }
        catch {
            offline = false;
        }
        if (!offline)
            return busy("offline_writer_preflight_required");
        const account = this.accounts.get(accountId);
        if (!account)
            return unavailable("offline_conversion_account_unknown");
        const primaryPath = writerLockPath(this.primaryAccount());
        const primaryIdentity = secondaryOnly
            ? nativeWriterLockDirectoryIdentity(this.primaryAccount().codexHome, primaryPath)
            : this.ensurePrimaryWriterLock(primaryPath);
        if (!primaryIdentity)
            return collision("writer_lock_primary_invalid");
        const secondaryPath = writerLockPath(account);
        const backupPath = this.lockBackupPath(account);
        const prior = this.document.lockConversions[accountId];
        const safeToChangeSecondary = () => {
            try {
                return this.basePreflight(!secondaryOnly).state === "ready"
                    && options.offlinePreflight() === true && options.offlinePreflight() === true
                    && nativeWriterLockDirectoryHasIdentity(this.primaryAccount().codexHome, primaryPath, primaryIdentity);
            }
            catch {
                return false;
            }
        };
        // Resume only a journaled prior move whose exact inode is still retained.
        if (prior?.phase === "moved") {
            if (!safeToChangeSecondary())
                return busy("offline_writer_preflight_required");
            if (prior.oldIdentity && this.resumeOfflineConversion(account, secondaryPath, backupPath, primaryPath, primaryIdentity, prior)) {
                return this.preflightSharedWriterLocks();
            }
            this.recordLockConversion(accountId, prior.oldIdentity, primaryIdentity, "collision");
            return collision("offline_conversion_recovery_collision");
        }
        let stat;
        try {
            stat = (0, node_fs_1.lstatSync)(secondaryPath);
        }
        catch (error) {
            if (secondaryOnly && error.code === "ENOENT") {
                if (!safeToChangeSecondary())
                    return busy("offline_writer_preflight_required");
                this.recordLockConversion(accountId, null, primaryIdentity, "intent");
                try {
                    publishWriterLockSymlink(secondaryPath, primaryPath);
                    if (!exactWriterLockSymlink(secondaryPath, primaryPath, primaryIdentity))
                        throw new Error("writer lock projection mismatch");
                    this.recordLockConversion(accountId, null, primaryIdentity, "published");
                    return this.preflightSharedWriterLocks();
                }
                catch {
                    this.recordLockConversion(accountId, null, primaryIdentity, "collision");
                    return collision("writer_lock_projection_publish_failed");
                }
            }
            if (error.code === "ENOENT")
                return unavailable("offline_conversion_directory_missing");
            return unavailable("offline_conversion_directory_unreadable");
        }
        if (stat.isSymbolicLink()) {
            return exactWriterLockSymlink(secondaryPath, primaryPath, primaryIdentity)
                ? this.preflightSharedWriterLocks()
                : collision("writer_lock_projection_drift");
        }
        const oldIdentity = nativeWriterLockDirectoryIdentity(account.codexHome, secondaryPath);
        if (!oldIdentity)
            return collision("offline_conversion_directory_invalid");
        if ((0, node_fs_1.existsSync)(backupPath))
            return collision("offline_conversion_backup_exists");
        this.recordLockConversion(accountId, oldIdentity, primaryIdentity, "intent");
        if (!safeToChangeSecondary())
            return busy("offline_writer_preflight_required");
        try {
            // Both source and retained backup are direct children of the sealed
            // CODEX_HOME, so this is same-parent and cannot cross a filesystem.
            (0, node_fs_1.renameSync)(secondaryPath, backupPath);
            if (!nativeWriterLockDirectoryHasIdentity(account.codexHome, backupPath, oldIdentity) || (0, node_fs_1.existsSync)(secondaryPath)) {
                throw new Error("offline conversion move changed");
            }
            this.recordLockConversion(accountId, oldIdentity, primaryIdentity, "moved");
            publishWriterLockSymlink(secondaryPath, primaryPath);
            if (!exactWriterLockSymlink(secondaryPath, primaryPath, primaryIdentity))
                throw new Error("offline conversion projection changed");
            this.recordLockConversion(accountId, oldIdentity, primaryIdentity, "published");
            return this.preflightSharedWriterLocks();
        }
        catch {
            if (this.rollbackOfflineConversion(account, secondaryPath, backupPath, primaryPath, oldIdentity, primaryIdentity)) {
                this.recordLockConversion(accountId, oldIdentity, primaryIdentity, "rolled_back");
                return unavailable("offline_conversion_rolled_back");
            }
            this.recordLockConversion(accountId, oldIdentity, primaryIdentity, "collision");
            return collision("offline_conversion_collision");
        }
    }
    async reconcileCatalog(options = {}) {
        if (!(0, types_1.isPlainRecord)(options) || (options.project !== undefined && typeof options.project !== "boolean")) {
            return { state: "unavailable", reason: "catalog_reconcile_input_invalid" };
        }
        const project = options.project !== false;
        const capability = await this.probeCapability();
        if (capability.state !== "ready")
            return { state: "unsupported", reason: capability.reason };
        const base = this.basePreflight();
        if (base.state !== "ready")
            return { state: base.state, reason: base.reason };
        // A provenance-only remote poll must remain available before catalog
        // projection is enabled. It only reads native rows and writes the private
        // origin receipt, so it neither creates links nor touches target SQLite.
        if (project) {
            const locks = this.preflightSharedWriterLocks();
            if (locks.state !== "ready")
                return { state: locks.state, reason: locks.reason };
        }
        const schemas = new Map();
        try {
            for (const account of this.accounts.values()) {
                const schema = await this.options.db.inspectSchema(databasePath(account));
                if (!schemaReady(schema))
                    return { state: "unsupported", reason: "threads_schema_unsupported" };
                schemas.set(account.accountId, schema);
            }
        }
        catch {
            return { state: "unavailable", reason: "threads_schema_unavailable" };
        }
        if (schemas.size !== this.accounts.size)
            return { state: "unavailable", reason: "threads_schema_unavailable" };
        const sightings = new Map();
        let scanned = 0;
        try {
            for (const account of this.accounts.values()) {
                let cursor;
                const seenCursors = new Set();
                do {
                    const page = await this.options.db.scanEligibleRows(databasePath(account), cursor);
                    if (!validPage(page))
                        return { state: "unavailable", reason: "threads_scan_invalid" };
                    for (const row of page.rows) {
                        if (!eligibleRow(row))
                            return { state: "unavailable", reason: "threads_scan_invalid" };
                        scanned += 1;
                        if (scanned > exports.NATIVE_CATALOG_MAX_THREADS_V1 * this.accounts.size)
                            return { state: "unavailable", reason: "threads_scan_overflow" };
                        const byAccount = sightings.get(row.threadId) ?? new Map();
                        if (byAccount.has(account.accountId))
                            return { state: "unavailable", reason: "threads_scan_duplicate" };
                        byAccount.set(account.accountId, row);
                        sightings.set(row.threadId, byAccount);
                    }
                    cursor = page.nextCursor ?? undefined;
                    if (cursor) {
                        const key = String(cursor.updatedAtMs) + "\0" + cursor.threadId;
                        if (seenCursors.has(key))
                            return { state: "unavailable", reason: "threads_scan_cursor_stalled" };
                        seenCursors.add(key);
                    }
                } while (cursor);
            }
        }
        catch {
            return { state: "unavailable", reason: "threads_scan_unavailable" };
        }
        if (sightings.size > exports.NATIVE_CATALOG_MAX_THREADS_V1)
            return { state: "unavailable", reason: "threads_catalog_capacity" };
        if (project && [...sightings.values()].some((rows) => [...rows.values()].some((row) => row.historyMode === "paginated"))) {
            return { state: "unsupported", reason: "paginated_catalog_mirroring_refused" };
        }
        let collisions = 0;
        let projected = 0;
        const unverifiable = [];
        for (const [threadId, byAccount] of sightings) {
            let record = this.document.threads[threadId];
            if (!record) {
                // A new remote-created row becomes an owner receipt before any
                // projection. A duplicate with no receipt has no safe owner.
                if (byAccount.size !== 1) {
                    collisions += 1;
                    continue;
                }
                const [originAccountId, row] = [...byAccount.entries()][0];
                const originAccount = this.accounts.get(originAccountId);
                if (!originAccount) {
                    collisions += 1;
                    continue;
                }
                const sourceIdentity = pinnedRolloutIdentity(originAccount, row.rolloutPath, row.threadId);
                if (!sourceIdentity) {
                    // A concurrent recorder can replace the pathname or append between
                    // the pin checks. Do not make an unqualified busy row terminal;
                    // only a clear per-thread census turns this into a real collision.
                    unverifiable.push({ row, accountId: originAccountId, recordJson: null });
                    continue;
                }
                const sourceDigest = rowDigest(row);
                this.mutate((next) => {
                    if (next.threads[threadId])
                        throw new Error("native catalog thread changed during reconciliation");
                    next.threads[threadId] = {
                        threadId,
                        originAccountId,
                        writerAccountId: originAccountId,
                        sourceRolloutIdentity: sourceIdentity,
                        sourceRowDigest: sourceDigest,
                        projections: {
                            [originAccountId]: {
                                state: "committed",
                                targetPath: row.rolloutPath,
                                rolloutIdentity: sourceIdentity,
                                rowDigest: sourceDigest,
                            },
                        },
                    };
                });
                record = this.document.threads[threadId];
            }
            const knownSightings = this.validateKnownSightings(record, byAccount);
            if (typeof knownSightings !== "string") {
                unverifiable.push({ ...knownSightings, recordJson: JSON.stringify(record) });
                continue;
            }
            if (knownSightings === "collision") {
                this.markThreadCollision(threadId);
                collisions += 1;
                continue;
            }
            if (!project)
                continue;
            for (const target of this.accounts.values()) {
                if (target.accountId === record.originAccountId)
                    continue;
                const result = await this.ensureProjection(record.threadId, target.accountId);
                if (result === "projected")
                    projected += 1;
                else if (result === "collision")
                    collisions += 1;
                else if (result === "unavailable")
                    return { state: "unavailable", reason: "projection_unavailable" };
                // Per-thread contention is not a catalog failure. This pass leaves the
                // row alone and lets a later idle pass publish it.
            }
        }
        if (unverifiable.length > 0) {
            // Native cleanup can leave many unavailable rollout paths. Repeating a
            // synchronous machine-wide census for every row starves the broker's
            // command socket. Collect these diagnostics, then await one OS snapshot.
            let observed = new Map();
            try {
                observed = this.options.catalogThreadCensus
                    ? await this.options.catalogThreadCensus(unverifiable.map(({ row }) => row.threadId))
                    : new Map(unverifiable.map(({ row, accountId }) => [row.threadId, this.exactThreadCensus(row.threadId, accountId)]));
            }
            catch { /* Unknown evidence defers the rows without marking a collision. */ }
            const currentBinding = this.basePreflight();
            if (currentBinding.state !== "ready")
                return { state: currentBinding.state, reason: currentBinding.reason };
            for (const { row, accountId, recordJson } of unverifiable) {
                if (observed.get(row.threadId) !== "clear" || this.hasUnsettledOperation(row.threadId))
                    continue;
                const current = this.document.threads[row.threadId];
                if ((current ? JSON.stringify(current) : null) !== recordJson)
                    continue;
                // A recorder or another request may have repaired the path while the
                // asynchronous census ran. Leave it for a fresh catalog pass.
                if (pinnedRolloutIdentity(this.accounts.get(accountId), row.rolloutPath, row.threadId))
                    continue;
                if (current)
                    this.markThreadCollision(row.threadId);
                collisions += 1;
            }
        }
        return collisions > 0
            ? { state: "collision", scanned, projected, collisions }
            : { state: "ready", scanned, projected, collisions };
    }
    pendingTransfersForRecovery() {
        return Object.values(this.document.operations).filter((operation) => operation.phase !== "owner_committed" && operation.phase !== "source_owned")
            .map(({ operationId, threadId, sourceAccountId, targetAccountId, phase }) => ({ operationId, threadId, sourceAccountId, targetAccountId, phase }));
    }
    async recoverInterruptedTransfers(loadedByAccount) {
        const settledOperationIds = [];
        const heldOperationIds = [];
        const heldThreadIds = new Set();
        const hold = (operation) => { heldOperationIds.push(operation.operationId); heldThreadIds.add(operation.threadId); };
        const evidenceReady = validLoadedMap(loadedByAccount, this.accountIds) && this.preflightSharedWriterLocksReady();
        for (const operation of Object.values(this.document.operations)) {
            if (operation.phase === "owner_committed" || operation.phase === "source_owned" || operation.phase === "target_resumed")
                continue;
            // Dispatching/ambiguous phases never imply that a native resume did not
            // happen. They remain held; recovery must not replay the continuation.
            if (!evidenceReady || this.document.version !== 2 || operation.transferVersion !== 2 && !operation.generation
                || operation.phase !== "preparing" && operation.phase !== "target_prepared"
                || this.document.threads[operation.threadId]?.writerAccountId !== operation.sourceAccountId
                || loadedAccountsForThread(loadedByAccount, operation.threadId).some((account) => account !== operation.sourceAccountId)
                || this.exactThreadCensus(operation.threadId, operation.sourceAccountId) !== "clear"
                || this.exactThreadCensus(operation.threadId, operation.targetAccountId) !== "clear") {
                hold(operation);
                continue;
            }
            // The durable pre-dispatch phase proves no resume was sent. Preserve
            // partial projections and their immutable intent, but release the orphan
            // ID so a new explicit user action can prepare a fresh generation.
            this.updateOperation(operation.operationId, "source_owned");
            settledOperationIds.push(operation.operationId);
        }
        return { settledOperationIds, heldOperationIds, heldThreadIds: [...heldThreadIds] };
    }
    async sourceProjectionReady(threadId, accountId) {
        if (this.document.threads[threadId]?.writerAccountId !== accountId)
            return false;
        try {
            return Boolean(await this.captureGeneration(threadId, accountId));
        }
        catch {
            return false;
        }
    }
    writerLockMatches(operation) {
        if (!operation.writerLock || !this.preflightSharedWriterLocksReady())
            return false;
        const primary = this.accounts.get(this.options.primaryAccountId);
        const directory = writerLockPath(primary);
        const identity = observedNativeWriterLock((0, node_path_1.join)(directory, operation.threadId + ".lock"), directory, primary.codexHome);
        return Boolean(identity && String(identity.dev) === operation.writerLock.dev && String(identity.ino) === operation.writerLock.ino);
    }
    preparationLeaseHeld(operationId) {
        const operation = this.document.operations[operationId];
        const lease = this.preparationLeases.get(operationId);
        return Boolean(operation && lease && lease.isHeld() && operation.writerLock?.dev === lease.dev
            && operation.writerLock?.ino === lease.ino && this.writerLockMatches(operation));
    }
    releasePreparationLease(operationId) {
        const lease = this.preparationLeases.get(operationId);
        this.preparationLeases.delete(operationId);
        lease?.release();
    }
    releasePreparationLeaseForResume(operationId) {
        const operation = this.document.operations[operationId];
        if (!operation || operation.phase !== "resume_dispatching")
            return false;
        if (!operation.generation)
            return true;
        if (!this.preparationLeaseHeld(operationId)) {
            this.releasePreparationLease(operationId);
            return false;
        }
        this.releasePreparationLease(operationId);
        return this.writerLockMatches(operation);
    }
    async revalidatePrepared(operationId) {
        const operation = this.document.operations[operationId];
        if (!operation || operation.phase !== "target_prepared" || !operation.generation || !this.preparationLeaseHeld(operationId))
            return false;
        if (this.document.threads[operation.threadId]?.writerAccountId !== operation.sourceAccountId
            || this.exactThreadCensus(operation.threadId, operation.sourceAccountId) !== "clear"
            || this.exactThreadCensus(operation.threadId, operation.targetAccountId) !== "clear")
            return false;
        return await this.preparedGenerationMatches(operation) && this.preparationLeaseHeld(operationId);
    }
    async revalidateResumedGeneration(operationId) {
        this.resumedGenerationProofs.delete(operationId);
        const operation = this.document.operations[operationId];
        if (!operation || operation.phase !== "resume_dispatching" && operation.phase !== "target_resumed")
            return false;
        if (!operation.generation)
            return true;
        if (this.document.threads[operation.threadId]?.writerAccountId !== operation.sourceAccountId)
            return false;
        const writerProved = () => {
            try {
                return Boolean(operation.writerLock && !this.preparationLeases.has(operationId) && this.writerLockMatches(operation)
                    && this.exactThreadCensus(operation.threadId, operation.sourceAccountId) === "clear"
                    && this.options.resumedWriterLockProof?.(operation.threadId, operation.targetAccountId, operation.writerLock));
            }
            catch {
                return false;
            }
        };
        if (!writerProved() || !await this.preparedGenerationMatches(operation) || !writerProved())
            return false;
        this.resumedGenerationProofs.add(operationId);
        return true;
    }
    async preparedGenerationMatches(operation) {
        if (!operation.generation)
            return false;
        try {
            const source = await this.captureGeneration(operation.threadId, operation.sourceAccountId);
            if (source.digest !== operation.generation.digest)
                return false;
            return this.targetGenerationMatches(operation, source);
        }
        catch {
            return false;
        }
    }
    async targetGenerationMatches(operation, source) {
        try {
            const target = this.accounts.get(operation.targetAccountId);
            const row = await this.options.db.readExact(databasePath(target), operation.threadId);
            if (!row || row.rolloutPath !== operation.targetPath)
                return false;
            for (const stream of source.streams) {
                const path = targetRolloutPath(this.accounts.get(operation.sourceAccountId), target, stream.path, operation.threadId);
                if (!path || !nativeRolloutFileHasIdentity(path, stream.identity) || nativeRolloutFileStat(path)?.size !== stream.size
                    || digestNativeStream(path) !== stream.digest)
                    return false;
            }
            if (source.history) {
                const history = await this.options.db.readHistorySnapshot((0, node_path_1.join)(target.sqliteHome, "thread_history_1.sqlite"), source.streams.map((stream) => stream.streamId));
                if (canonicalJson(history) !== canonicalJson(source.history))
                    return false;
            }
            return canonicalJson(row.values) === canonicalJson({ ...source.row.values, rollout_path: operation.targetPath });
        }
        catch {
            return false;
        }
    }
    async captureGeneration(threadId, accountId) {
        const account = this.accounts.get(accountId);
        if (!account || !validNativeThreadId(threadId) || !this.options.bindingPreflight())
            throw new Error("generation binding invalid");
        const row = await this.options.db.readExact(databasePath(account), threadId);
        if (!row || !eligibleRow(row))
            throw new Error("generation row unavailable");
        const streams = [];
        const visit = (path, depth) => {
            if (!safeNativeRolloutDirectoryChain(account.codexHome, path))
                throw new Error("unsafe stream directory");
            const entries = (0, node_fs_1.readdirSync)(path, { withFileTypes: true });
            if (entries.length > 32768)
                throw new Error("stream scan bound exceeded");
            for (const entry of entries) {
                const child = (0, node_path_1.join)(path, entry.name);
                if (depth < 3 && entry.isDirectory())
                    visit(child, depth + 1);
                else if (depth === 3 && rolloutRelativeSuffix(account, child, threadId)) {
                    if (streams.length >= 1024)
                        throw new Error("stream count exceeded");
                    const identity = pinnedRolloutIdentity(account, child, threadId);
                    const stat = nativeRolloutFileStat(child);
                    if (!identity || !stat)
                        throw new Error("stream changed");
                    const match = /_([a-f0-9-]{36})\.jsonl$/.exec(entry.name);
                    const streamId = match?.[1] ?? threadId;
                    if (!validNativeThreadId(streamId))
                        throw new Error("invalid stream id");
                    streams.push({ path: child, streamId, identity, size: stat.size, digest: digestNativeStream(child) });
                }
            }
        };
        visit((0, node_path_1.join)(account.codexHome, "sessions"), 0);
        streams.sort((a, b) => a.path.localeCompare(b.path));
        if (!streams.some((stream) => stream.path === row.rolloutPath))
            throw new Error("current stream unavailable");
        const history = row.historyMode === "paginated"
            ? await this.options.db.readHistorySnapshot?.((0, node_path_1.join)(account.sqliteHome, "thread_history_1.sqlite"), streams.map((stream) => stream.streamId)) : null;
        if (row.historyMode === "paginated" && !history)
            throw new Error("history snapshot unavailable");
        if (history)
            for (const stream of streams) {
                const projections = history.rows.thread_history_projection_state?.filter((value) => value.thread_id === stream.streamId) ?? [];
                if (projections.length !== 1 || projections[0].next_rollout_byte_offset !== stream.size)
                    throw new Error("history projection behind stream");
            }
        for (const stream of streams)
            if (!nativeRolloutFileHasIdentity(stream.path, stream.identity)
                || nativeRolloutFileStat(stream.path)?.size !== stream.size || digestNativeStream(stream.path) !== stream.digest)
                throw new Error("stream generation changed");
        const currentRow = await this.options.db.readExact(databasePath(account), threadId);
        if (canonicalJson(currentRow) !== canonicalJson(row))
            throw new Error("row generation changed");
        const value = { row, streams, history: history ?? null };
        return { ...value, digest: "sha256:" + (0, node_crypto_1.createHash)("sha256").update(canonicalJson(value)).digest("hex") };
    }
    async prepareGeneration(input) {
        if (!this.options.recoveryCompatibilityPreflight?.())
            return { state: "unsupported" };
        if (Object.values(this.document.operations).some((operation) => operation.threadId === input.threadId && operation.operationId !== input.operationId && operation.phase !== "owner_committed" && operation.phase !== "source_owned"))
            return { state: "busy" };
        if (!this.options.db.refreshProjection)
            return { state: "unsupported" };
        const source = this.accounts.get(input.sourceAccountId);
        const target = this.accounts.get(input.targetAccountId);
        let generation;
        try {
            generation = await this.captureGeneration(input.threadId, input.sourceAccountId);
        }
        catch {
            return { state: "busy" };
        }
        const existingRow = await this.options.db.readExact(databasePath(target), input.threadId);
        const localProjection = existingRow ? { state: "none" }
            : this.retirements.localProjectionValues(input.threadId, input.targetAccountId, [...EXCLUDED_THREAD_COLUMNS]);
        if (localProjection.state === "held" || !existingRow && localProjection.state === "none"
            && Object.values(this.document.operations).some((operation) => operation.threadId === input.threadId
                && operation.sourceAccountId === input.targetAccountId && operation.phase === "owner_committed" && operation.generation?.history))
            return { state: "busy" };
        const existingProjection = this.document.threads[input.threadId]?.projections[input.targetAccountId];
        const predecessor = Object.values(this.document.operations).find((operation) => operation.threadId === input.threadId
            && operation.sourceAccountId === input.sourceAccountId && operation.targetAccountId === input.targetAccountId && operation.generation
            && (operation.operationId === input.operationId && operation.phase === "preparing" || operation.phase === "source_owned")
            && existingRow?.rolloutPath === targetRolloutPath(source, target, operation.generation.row.rolloutPath, input.threadId)
            && canonicalJson(existingRow?.values) === canonicalJson({ ...operation.generation.row.values, rollout_path: existingRow?.rolloutPath }));
        const priorGeneration = predecessor?.generation;
        const priorPath = priorGeneration ? targetRolloutPath(source, target, priorGeneration.row.rolloutPath, input.threadId) : null;
        const recoveringOwnPublication = Boolean(existingRow && priorGeneration && priorPath
            && (predecessor?.phase === "preparing" || predecessor?.phase === "source_owned")
            && canonicalJson(existingRow.values) === canonicalJson({ ...priorGeneration.row.values, rollout_path: priorPath })
            && priorGeneration.streams.every((stream) => {
                const targetPath = targetRolloutPath(source, target, stream.path, input.threadId);
                return targetPath && nativeRolloutFileHasIdentity(targetPath, stream.identity);
            }));
        if (existingRow && !recoveringOwnPublication && (!existingProjection || existingProjection.state !== "committed"
            || existingRow.rolloutPath !== existingProjection.targetPath
            || !nativeRolloutFileHasIdentity(existingProjection.targetPath, existingProjection.rolloutIdentity)))
            return { state: "collision" };
        if (generation.history) {
            try {
                const targetHistory = await this.options.db.readHistorySnapshot?.((0, node_path_1.join)(target.sqliteHome, "thread_history_1.sqlite"), generation.streams.map((stream) => stream.streamId));
                if (!targetHistory || targetHistory.schema !== generation.history.schema)
                    return { state: "unsupported" };
            }
            catch {
                return { state: "unsupported" };
            }
        }
        // The minimum-version marker precedes every v2 publication and is never removed on failure.
        try {
            this.ensureMinimumReaderMarker();
        }
        catch {
            return { state: "unsupported" };
        }
        const path = targetRolloutPath(source, target, generation.row.rolloutPath, input.threadId);
        if (!path)
            return { state: "collision" };
        this.mutate((next) => {
            const operation = next.operations[input.operationId];
            next.version = 2;
            operation.generation = generation;
        });
        // An older retirement never authorizes remote access after this account
        // begins receiving a current-owner projection again.
        this.retirements.invalidateProjection(input.threadId, input.targetAccountId);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                if (!this.preparationLeaseHeld(input.operationId) || (await this.captureGeneration(input.threadId, input.sourceAccountId)).digest !== generation.digest)
                    return { state: "busy" };
                if (this.exactThreadCensus(input.threadId, input.sourceAccountId) !== "clear" || this.exactThreadCensus(input.threadId, input.targetAccountId) !== "clear")
                    return { state: "busy" };
                for (const stream of generation.streams) {
                    if (publishRolloutHardLink(source, target, stream.path, input.threadId, stream.identity).state !== "ready")
                        return { state: "collision" };
                }
                if (generation.history) {
                    if (!this.options.db.replaceHistorySnapshot)
                        return { state: "unsupported" };
                    await this.options.db.replaceHistorySnapshot((0, node_path_1.join)(target.sqliteHome, "thread_history_1.sqlite"), generation.history, generation.streams.map((stream) => stream.streamId));
                }
                if (!this.preparationLeaseHeld(input.operationId))
                    return { state: "busy" };
                await this.options.db.refreshProjection({ sourceDbPath: databasePath(source), targetDbPath: databasePath(target), source: generation.row, targetPath: path,
                    ...(localProjection.state === "ready" ? { targetLocalValues: localProjection.values } : {}) });
                if (!this.preparationLeaseHeld(input.operationId) || (await this.captureGeneration(input.threadId, input.sourceAccountId)).digest !== generation.digest)
                    return { state: "busy" };
                const identity = generation.streams.find((stream) => stream.path === generation.row.rolloutPath).identity;
                this.mutate((next) => {
                    const record = next.threads[input.threadId];
                    record.projections[input.targetAccountId] = { state: "committed", targetPath: path, rolloutIdentity: identity, rowDigest: rowDigestWithPath(generation.row, path) };
                    if (input.targetAccountId === record.originAccountId) {
                        record.sourceRolloutIdentity = identity;
                        record.sourceRowDigest = rowDigestWithPath(generation.row, path);
                    }
                    const operation = next.operations[input.operationId];
                    operation.targetPath = path;
                    operation.targetIdentity = identity;
                    operation.phase = "target_prepared";
                });
                return await this.revalidatePrepared(input.operationId) ? readyPrepare(this.document.operations[input.operationId]) : { state: "busy" };
            }
            catch (error) {
                if (!/database is locked|SQLITE_BUSY/i.test(String(error)) || attempt === 2)
                    return { state: "unavailable" };
            }
        }
        return { state: "unavailable" };
    }
    async prepareSameThreadTransfer(input) {
        if (!this.options.db.refreshProjection)
            return this.prepareSameThreadTransferUnderLease(input);
        if (!validTransferInput(input) || !this.accounts.has(input.sourceAccountId) || !this.accounts.has(input.targetAccountId))
            return { state: "unavailable" };
        if ((await this.probeCapability()).state !== "ready" || !this.preflightSharedWriterLocksReady())
            return { state: "unsupported" };
        if (this.exactThreadCensus(input.threadId, input.sourceAccountId) !== "clear"
            || this.exactThreadCensus(input.threadId, input.targetAccountId) !== "clear")
            return { state: "busy" };
        if (!this.preparationLeases.has(input.operationId)) {
            const acquired = (this.options.acquirePreparationLease ?? native_thread_writer_lease_1.acquireNativeThreadWriterLease)(writerLockPath(this.accounts.get(this.options.primaryAccountId)), input.threadId);
            if (acquired.state !== "ready")
                return { state: acquired.state === "busy" ? "busy" : "unsupported" };
            this.preparationLeases.set(input.operationId, acquired.lease);
        }
        let retain = false;
        try {
            if (!this.preparationLeases.get(input.operationId).isHeld())
                return { state: "busy" };
            const result = await this.prepareSameThreadTransferUnderLease(input);
            retain = result.state === "ready";
            return result;
        }
        finally {
            if (!retain)
                this.releasePreparationLease(input.operationId);
        }
    }
    async prepareSameThreadTransferUnderLease(input) {
        const capability = await this.probeCapability();
        if (capability.state !== "ready")
            return { state: "unsupported" };
        const locks = this.preflightSharedWriterLocks();
        if (locks.state !== "ready")
            return { state: locks.state === "unsupported" ? "unsupported" : locks.state === "collision" ? "collision" : "unavailable" };
        if (!validTransferInput(input) || !this.accounts.has(input.sourceAccountId) || !this.accounts.has(input.targetAccountId)) {
            return { state: "unavailable" };
        }
        const existing = this.document.operations[input.operationId];
        if (existing) {
            if (!sameOperation(existing, input))
                return { state: "collision" };
            if (existing.phase === "target_prepared" || existing.phase === "resume_dispatching" || existing.phase === "target_resumed" || existing.phase === "owner_committed") {
                return existing.phase === "target_prepared" && existing.targetPath && (!existing.generation || await this.revalidatePrepared(input.operationId)) ? readyPrepare(existing) : { state: "busy" };
            }
            if (existing.phase === "collision")
                return { state: "collision" };
            if (existing.phase === "source_owned" || existing.phase === "ambiguous")
                return { state: "busy" };
        }
        const record = this.document.threads[input.threadId];
        if (!record || record.writerAccountId !== input.sourceAccountId || this.hasThreadCollision(record)) {
            if (existing)
                this.updateOperation(input.operationId, "collision");
            return { state: "collision" };
        }
        const sourceCensus = this.exactThreadCensus(input.threadId, input.sourceAccountId);
        const targetCensus = this.exactThreadCensus(input.threadId, input.targetAccountId);
        if (sourceCensus !== "clear" || targetCensus !== "clear") {
            return { state: sourceCensus === "conflict" || targetCensus === "conflict" ? "busy" : "unavailable" };
        }
        if (Object.values(this.document.operations).some((operation) => operation.threadId === input.threadId && operation.operationId !== input.operationId
            && operation.phase !== "owner_committed" && operation.phase !== "source_owned"))
            return { state: "busy" };
        if (this.options.db.refreshProjection && this.document.version === 1) {
            if (!this.options.recoveryCompatibilityPreflight?.())
                return { state: "unsupported" };
            // Structural migration retains unrelated v1 records as unrefreshed
            // provenance. Only this selected current owner needs fresh evidence.
            // Ordinary metadata/continuation changes are not origin collisions.
            let generation;
            try {
                generation = await this.captureGeneration(input.threadId, input.sourceAccountId);
            }
            catch {
                return { state: "busy" };
            }
            const sourceProjection = record.projections[input.sourceAccountId];
            if (!sourceProjection || sourceProjection.state !== "committed"
                || !generation.streams.some((stream) => sameIdentity(stream.identity, sourceProjection.rolloutIdentity)))
                return { state: "collision" };
            const currentStream = generation.streams.find((stream) => stream.path === generation.row.rolloutPath);
            try {
                this.ensureMinimumReaderMarker();
            }
            catch {
                return { state: "unsupported" };
            }
            this.mutate((next) => {
                const selected = next.threads[input.threadId];
                if (!selected || selected.writerAccountId !== input.sourceAccountId || this.hasThreadCollision(selected))
                    throw new Error("native migration owner changed");
                next.version = 2;
                selected.projections[input.sourceAccountId] = { state: "committed", targetPath: generation.row.rolloutPath,
                    rolloutIdentity: currentStream.identity, rowDigest: rowDigest(generation.row) };
                if (selected.originAccountId === input.sourceAccountId) {
                    selected.sourceRolloutIdentity = currentStream.identity;
                    selected.sourceRowDigest = rowDigest(generation.row);
                }
            });
        }
        if (Object.values(this.document.operations).some((operation) => operation.threadId === input.threadId && operation.operationId !== input.operationId
            && operation.phase !== "owner_committed" && operation.phase !== "source_owned"))
            return { state: "busy" };
        if (!existing) {
            // Persist before the first mutable projection action, but never leave a
            // pending receipt behind for a failed read-only precondition.
            this.mutate((next) => {
                next.operations[input.operationId] = {
                    operationId: input.operationId,
                    ...(this.options.db.refreshProjection ? { transferVersion: 2,
                        writerLock: { dev: this.preparationLeases.get(input.operationId).dev, ino: this.preparationLeases.get(input.operationId).ino } } : {}),
                    threadId: input.threadId,
                    sourceAccountId: input.sourceAccountId,
                    targetAccountId: input.targetAccountId,
                    targetPath: null,
                    targetIdentity: null,
                    phase: "preparing",
                    updatedAt: this.timestamp(),
                };
            });
        }
        if (this.options.db.refreshProjection) {
            const lease = this.preparationLeases.get(input.operationId);
            this.mutate((next) => { next.operations[input.operationId].writerLock = { dev: lease.dev, ino: lease.ino }; });
            if (!this.preparationLeaseHeld(input.operationId))
                return { state: "busy" };
            return this.prepareGeneration(input);
        }
        const projection = await this.ensureProjection(input.threadId, input.targetAccountId);
        if (projection === "collision") {
            this.updateOperation(input.operationId, "collision");
            return { state: "collision" };
        }
        if (projection === "unavailable")
            return { state: "unavailable" };
        if (projection === "busy")
            return { state: "busy" };
        const target = this.document.threads[input.threadId]?.projections[input.targetAccountId];
        if (!target || target.state !== "committed" || !nativeRolloutFileHasIdentity(target.targetPath, target.rolloutIdentity)) {
            this.updateOperation(input.operationId, "collision");
            return { state: "collision" };
        }
        this.mutate((next) => {
            const operation = next.operations[input.operationId];
            if (!operation || !sameOperation(operation, input))
                throw new Error("native transfer operation changed during preparation");
            operation.targetPath = target.targetPath;
            operation.targetIdentity = { ...target.rolloutIdentity };
            operation.phase = "target_prepared";
            operation.updatedAt = this.timestamp();
        });
        return {
            state: "ready",
            operationId: input.operationId,
            threadId: input.threadId,
            targetPath: target.targetPath,
            sourceAccountId: input.sourceAccountId,
            targetAccountId: input.targetAccountId,
        };
    }
    markResumeDispatching(operationId) {
        const operation = this.document.operations[operationId];
        if (!operation)
            throw new Error("unknown native transfer operation");
        if (operation.phase === "resume_dispatching")
            return;
        if (operation.phase !== "target_prepared")
            throw new Error("native transfer is not prepared for resume");
        if (operation.generation && !this.preparationLeaseHeld(operationId))
            throw new Error("native preparation lease is unavailable");
        this.updateOperation(operationId, "resume_dispatching");
    }
    async confirmPreparationProbeBlocked(operationId, response) {
        const operation = this.document.operations[operationId];
        if (!operation || operation.phase !== "resume_dispatching" || !operation.generation
            || !(0, types_1.isPlainRecord)(response) || !(0, types_1.isPlainRecord)(response.error)
            || response.error.code !== -32600
            || response.error.message !== `thread ${operation.threadId} already has an active writer`)
            return false;
        const stillPrepared = () => this.document.operations[operationId]?.phase === "resume_dispatching"
            && this.document.threads[operation.threadId]?.writerAccountId === operation.sourceAccountId
            && this.preparationLeaseHeld(operationId)
            && this.exactThreadCensus(operation.threadId, operation.sourceAccountId) === "clear"
            && this.exactThreadCensus(operation.threadId, operation.targetAccountId) === "clear";
        if (!stillPrepared() || !await this.preparedGenerationMatches(operation) || !stillPrepared())
            return false;
        // The dispatch receipt must precede even the expected locked probe. Only
        // this exact response under the continuously held lease proves that no
        // native resume happened and permits a later, separate real dispatch.
        this.updateOperation(operationId, "target_prepared");
        return true;
    }
    settleResume(operationId, nativeResponse) {
        const operation = this.document.operations[operationId];
        if (!operation)
            return { state: "collision" };
        if (operation.phase === "target_resumed" || operation.phase === "owner_committed")
            return provedSettlement(operation);
        if (operation.phase !== "resume_dispatching")
            return { state: "collision" };
        if (explicitNativeError(nativeResponse)) {
            this.updateOperation(operationId, "source_owned");
            return { state: "source_owned" };
        }
        if (operation.generation && !this.resumedGenerationProofs.delete(operationId)) {
            this.updateOperation(operationId, "ambiguous");
            return { state: "ambiguous" };
        }
        const response = matchingResumeResponse(nativeResponse, operation);
        if (!response || !operation.targetIdentity || !this.preflightSharedWriterLocksReady()
            || !nativeRolloutFileHasIdentity(operation.targetPath, operation.targetIdentity)) {
            this.updateOperation(operationId, "ambiguous");
            return { state: "ambiguous" };
        }
        this.updateOperation(operationId, "target_resumed");
        return { state: "proved", operationId, accountId: operation.targetAccountId, threadId: operation.threadId, path: response.path };
    }
    recoverResume(operationId, loadedByAccount) {
        const operation = this.document.operations[operationId];
        if (!operation)
            return { state: "collision" };
        if (operation.phase === "target_resumed" || operation.phase === "owner_committed")
            return provedSettlement(operation);
        if (operation.phase !== "resume_dispatching")
            return operation.phase === "source_owned" ? { state: "source_owned" } : { state: "collision" };
        if (!validLoadedMap(loadedByAccount, this.accountIds) || !operation.targetPath || !operation.targetIdentity
            || !this.preflightSharedWriterLocksReady() || !nativeRolloutFileHasIdentity(operation.targetPath, operation.targetIdentity)) {
            this.updateOperation(operationId, "ambiguous");
            return { state: "ambiguous" };
        }
        const loaded = loadedAccountsForThread(loadedByAccount, operation.threadId);
        if (loaded.length === 1 && loaded[0] === operation.targetAccountId) {
            if (operation.generation && !this.resumedGenerationProofs.delete(operationId)) {
                this.updateOperation(operationId, "ambiguous");
                return { state: "ambiguous" };
            }
            this.updateOperation(operationId, "target_resumed");
            return provedSettlement(this.document.operations[operationId]);
        }
        if ((loaded.length === 0) || (loaded.length === 1 && loaded[0] === operation.sourceAccountId)) {
            this.updateOperation(operationId, "source_owned");
            return { state: "source_owned" };
        }
        this.updateOperation(operationId, "ambiguous");
        return { state: "ambiguous" };
    }
    /**
     * Called only after the host has committed both RouterStateStore and
     * canonical-history owner changes. This writes the terminal native receipt.
     */
    commitWriter(operationId) {
        const operation = this.document.operations[operationId];
        if (!operation)
            throw new Error("unknown native transfer operation");
        if (operation.phase === "owner_committed")
            return;
        if (operation.phase !== "target_resumed")
            throw new Error("native transfer writer commit is not proved");
        if (operation.generation)
            this.retirements.noteCommittedTransfer(operation.threadId, operationId, operation.sourceAccountId);
        this.mutate((next) => {
            const current = next.operations[operationId];
            const thread = next.threads[operation.threadId];
            if (!current || !thread || current.phase !== "target_resumed" || thread.writerAccountId !== current.sourceAccountId) {
                throw new Error("native transfer writer commit drifted");
            }
            thread.writerAccountId = current.targetAccountId;
            current.phase = "owner_committed";
            current.updatedAt = this.timestamp();
        });
    }
    canEnableRemote(accountId) {
        if (!this.accounts.has(accountId) || !this.options.bindingPreflight())
            return false;
        for (const record of Object.values(this.document.threads)) {
            if (record.projections[accountId] && (record.writerAccountId !== accountId || this.hasThreadCollision(record) || this.hasUnsettledOperation(record.threadId) || this.hasPendingSourceRetirement(record.threadId)))
                return false;
        }
        return !Object.values(this.document.operations).some((operation) => (operation.sourceAccountId === accountId || operation.targetAccountId === accountId)
            && operation.phase !== "owner_committed" && operation.phase !== "source_owned");
    }
    async verifyRemoteEligibility(accountId) {
        if (!this.accounts.has(accountId))
            return false;
        const before = documentDigest(this.document);
        try {
            if (!this.options.bindingPreflight() || !this.options.writerCensus())
                return false;
            for (const record of Object.values(this.document.threads)) {
                if (!record.projections[accountId])
                    continue;
                if (this.hasThreadCollision(record) || this.hasUnsettledOperation(record.threadId))
                    return false;
                if (this.hasPendingSourceRetirement(record.threadId))
                    return false;
                if (record.writerAccountId === accountId)
                    continue;
                const operationId = this.retirements.activeOperation(record.threadId, accountId);
                const context = operationId ? this.retirementContext(operationId, false) : null;
                if (!context || !await this.retirements.verify(context))
                    return false;
            }
            return before === documentDigest(this.document) && this.options.bindingPreflight() && this.options.writerCensus()
                && !Object.values(this.document.operations).some((operation) => (operation.sourceAccountId === accountId || operation.targetAccountId === accountId)
                    && operation.phase !== "owner_committed" && operation.phase !== "source_owned");
        }
        catch {
            return false;
        }
    }
    async retireSourceProjection(operationId) {
        const context = this.retirementContext(operationId, true);
        if (!context || this.retirementInFlight.has(context.threadId))
            return { state: "held" };
        this.retirementInFlight.add(context.threadId);
        try {
            return await this.retirements.retire(context);
        }
        finally {
            this.retirementInFlight.delete(context.threadId);
        }
    }
    pendingSourceRetirements() {
        return Object.values(this.document.operations).filter((operation) => {
            const record = this.document.threads[operation.threadId];
            if (operation.phase !== "owner_committed" || !operation.generation?.history || !operation.writerLock
                || !record || record.writerAccountId === operation.sourceAccountId)
                return false;
            try {
                const latest = this.retirements.latestOutgoingOperation(operation.threadId, operation.sourceAccountId);
                // A committed transfer proves an index entry must exist. Missing or
                // unreadable evidence holds the thread instead of implying retirement.
                return latest === null || latest === operation.operationId && !this.retirements.isRetired(operation.threadId, operation.sourceAccountId);
            }
            catch {
                return true;
            }
        }).map(({ operationId, threadId, sourceAccountId, targetAccountId }) => ({ operationId, threadId, sourceAccountId, targetAccountId }));
    }
    hasPendingSourceRetirement(threadId) {
        return this.pendingSourceRetirements().some((operation) => operation.threadId === threadId);
    }
    async recoverSourceRetirements() {
        const retiredOperationIds = [];
        const heldOperationIds = [];
        for (const operation of this.pendingSourceRetirements()) {
            const result = await this.retireSourceProjection(operation.operationId);
            (result.state === "retired" ? retiredOperationIds : heldOperationIds).push(operation.operationId);
        }
        return { retiredOperationIds, heldOperationIds };
    }
    retirementContext(operationId, requireCurrentTarget) {
        const operation = this.document.operations[operationId];
        const generation = operation?.generation;
        const record = operation ? this.document.threads[operation.threadId] : null;
        if (this.document.version !== 2 || !operation || operation.phase !== "owner_committed" || !operation.writerLock
            || !generation?.history || generation.row.historyMode !== "paginated" || !record
            || record.writerAccountId === operation.sourceAccountId || requireCurrentTarget && record.writerAccountId !== operation.targetAccountId
            || this.hasThreadCollision(record) || this.hasUnsettledOperation(operation.threadId))
            return null;
        const source = this.accounts.get(operation.sourceAccountId);
        const target = this.accounts.get(operation.targetAccountId);
        if (!source || !target)
            return null;
        const observationGuard = () => {
            try {
                const current = this.document.threads[operation.threadId];
                return this.document.operations[operationId]?.phase === "owner_committed" && Boolean(current)
                    && current.writerAccountId !== operation.sourceAccountId && (!requireCurrentTarget || current.writerAccountId === operation.targetAccountId)
                    && !this.hasThreadCollision(current) && !this.hasUnsettledOperation(operation.threadId)
                    && this.options.bindingPreflight() && this.options.writerCensus() && this.preflightSharedWriterLocksReady();
            }
            catch {
                return false;
            }
        };
        return { operationId, threadId: operation.threadId, source, target, generationDigest: generation.digest,
            expectedRow: generation.row.values, expectedHistory: generation.history, expectedStreams: generation.streams,
            observationGuard,
            mutationGuard: () => observationGuard() && this.options.accountOfflinePreflight?.(source.accountId) === true,
            targetStillPrepared: () => this.targetGenerationMatches(operation, generation) };
    }
    ownerForThread(threadId) {
        const record = this.document.threads[threadId];
        if (!record || this.hasThreadCollision(record))
            return null;
        const writer = record.projections[record.writerAccountId];
        return writer?.state === "committed" ? record.writerAccountId : null;
    }
    isCommittedProjection(threadId, accountId) {
        const record = this.document.threads[threadId];
        return Boolean(record && !this.hasThreadCollision(record) && record.projections[accountId]?.state === "committed"
            && !this.retirements.isRetired(threadId, accountId));
    }
    pendingWriterCommits() {
        return Object.values(this.document.operations)
            // `owner_committed` is a completed receipt, not recovery work. Replaying
            // old completed A→B transfers after a later B→A transfer would corrupt
            // the parent writer state.
            .filter((operation) => operation.phase === "target_resumed")
            .map((operation) => ({
            operationId: operation.operationId,
            threadId: operation.threadId,
            sourceAccountId: operation.sourceAccountId,
            targetAccountId: operation.targetAccountId,
            phase: operation.phase,
        }))
            .sort((left, right) => left.operationId.localeCompare(right.operationId));
    }
    /**
     * Reconciles a remote-owned writer only when the loaded-list gives exactly
     * one account, durable provenance still names the same hard-link inode, and
     * the shared lock projection has freshly passed.
     */
    reconcileRemoteWriter(loadedByAccount) {
        if (!validLoadedMap(loadedByAccount, this.accountIds)) {
            return { state: "unavailable", updatedThreadIds: [], collisionThreadIds: [] };
        }
        const locks = this.preflightSharedWriterLocks();
        if (locks.state !== "ready")
            return { state: locks.state, updatedThreadIds: [], collisionThreadIds: [] };
        const observed = new Map();
        for (const [accountId, threads] of loadedByAccount) {
            for (const loaded of threads) {
                const owners = observed.get(loaded.threadId) ?? [];
                owners.push(accountId);
                observed.set(loaded.threadId, owners);
            }
        }
        const updates = [];
        const collisions = [];
        let busy = false;
        for (const [threadId, accounts] of observed) {
            const record = this.document.threads[threadId];
            if (!record)
                continue;
            if (this.hasUnsettledOperation(threadId)) {
                // The parent owns the RouterStateStore/canonical-history commit that
                // pairs a local same-ID resume with its durable writer segment.
                // Remote polling must not race that bridge.
                busy = true;
                continue;
            }
            if (accounts.length !== 1 || this.hasThreadCollision(record)) {
                this.markThreadCollision(threadId);
                collisions.push(threadId);
                continue;
            }
            const accountId = accounts[0];
            const projection = record.projections[accountId];
            if (!projection || projection.state !== "committed" || !nativeRolloutFileHasIdentity(projection.targetPath, projection.rolloutIdentity)) {
                this.markThreadCollision(threadId);
                collisions.push(threadId);
                continue;
            }
            if (record.writerAccountId !== accountId && this.document.version === 2) {
                // A loaded list cannot prove that a remote child consumed this owner's
                // current paginated generation. Keep ownership held for recovery.
                busy = true;
                continue;
            }
            if (record.writerAccountId !== accountId) {
                this.mutate((next) => {
                    const current = next.threads[threadId];
                    if (!current || this.hasThreadCollision(current))
                        throw new Error("native remote writer drifted");
                    current.writerAccountId = accountId;
                });
                updates.push(threadId);
            }
        }
        return {
            state: collisions.length > 0 ? "collision" : busy ? "busy" : "ready",
            updatedThreadIds: updates,
            collisionThreadIds: collisions,
        };
    }
    basePreflight(requireGlobalWriterCensus = false) {
        if (this.capability?.state !== "ready")
            return this.capability ? unsupported(this.capability.reason) : unsupported("capability_not_probed");
        try {
            if (!this.options.bindingPreflight())
                return unavailable("native_history_binding_invalid");
            if (requireGlobalWriterCensus && !this.options.writerCensus())
                return busy("native_history_writer_busy");
            for (const account of this.accounts.values()) {
                const expected = this.accountHomeIdentities.get(account.accountId);
                const observed = accountHomeIdentities(account);
                if (!expected || !observed || !sameIdentity(expected.codexHome, observed.codexHome)
                    || !sameIdentity(expected.sqliteHome, observed.sqliteHome)) {
                    return unavailable("native_history_home_invalid");
                }
            }
            return { state: "ready", sharedWriterLockPath: "", identity: { dev: 0, ino: 0 } };
        }
        catch {
            return unavailable("native_history_preflight_failed");
        }
    }
    preflightSharedWriterLocksReady() {
        return this.preflightSharedWriterLocks().state === "ready";
    }
    primaryAccount() {
        return this.accounts.get(this.options.primaryAccountId);
    }
    secondaryAccounts() {
        return [...this.accounts.values()].filter((account) => account.accountId !== this.options.primaryAccountId);
    }
    ensurePrimaryWriterLock(path) {
        try {
            if (!(0, node_fs_1.existsSync)(path)) {
                (0, node_fs_1.mkdirSync)(path, { mode: PRIVATE_DIRECTORY_MODE });
                (0, node_fs_1.chmodSync)(path, PRIVATE_DIRECTORY_MODE);
            }
            return nativeWriterLockDirectoryIdentity(this.primaryAccount().codexHome, path);
        }
        catch {
            return null;
        }
    }
    lockBackupPath(account) {
        const suffix = (0, node_crypto_1.createHash)("sha256").update(account.accountId, "utf8").digest("hex").slice(0, 32);
        return (0, node_path_1.join)(account.codexHome, ".tweakers-native-writer-lock-backup-" + suffix);
    }
    resumeOfflineConversion(account, secondaryPath, backupPath, primaryPath, primaryIdentity, prior) {
        if (!prior.oldIdentity || !nativeWriterLockDirectoryHasIdentity(account.codexHome, backupPath, prior.oldIdentity))
            return false;
        try {
            if ((0, node_fs_1.existsSync)(secondaryPath)) {
                if (!exactWriterLockSymlink(secondaryPath, primaryPath, primaryIdentity))
                    return false;
            }
            else {
                publishWriterLockSymlink(secondaryPath, primaryPath);
            }
            if (!exactWriterLockSymlink(secondaryPath, primaryPath, primaryIdentity))
                return false;
            this.recordLockConversion(account.accountId, prior.oldIdentity, primaryIdentity, "published");
            return true;
        }
        catch {
            return false;
        }
    }
    rollbackOfflineConversion(account, secondaryPath, backupPath, primaryPath, oldIdentity, primaryIdentity) {
        try {
            if (!nativeWriterLockDirectoryHasIdentity(account.codexHome, backupPath, oldIdentity))
                return false;
            if ((0, node_fs_1.existsSync)(secondaryPath)) {
                if (!exactWriterLockSymlink(secondaryPath, primaryPath, primaryIdentity))
                    return false;
                const link = (0, node_fs_1.lstatSync)(secondaryPath);
                if (!link.isSymbolicLink())
                    return false;
                (0, node_fs_1.unlinkSync)(secondaryPath);
            }
            if ((0, node_fs_1.existsSync)(secondaryPath))
                return false;
            (0, node_fs_1.renameSync)(backupPath, secondaryPath);
            return nativeWriterLockDirectoryHasIdentity(account.codexHome, secondaryPath, oldIdentity);
        }
        catch {
            return false;
        }
    }
    recordLockConversion(accountId, oldIdentity, expectedCanonicalIdentity, phase) {
        this.mutate((next) => {
            next.lockConversions[accountId] = {
                accountId,
                oldIdentity: oldIdentity ? { ...oldIdentity } : null,
                expectedCanonicalIdentity: { ...expectedCanonicalIdentity },
                phase,
                timestamp: this.timestamp(),
            };
        });
    }
    validateKnownSightings(record, sightings) {
        if (this.hasThreadCollision(record))
            return "collision";
        for (const [accountId, row] of sightings) {
            const projection = record.projections[accountId];
            if (!projection || projection.state !== "committed")
                return "collision";
            if (projection.targetPath !== row.rolloutPath || projection.rowDigest !== rowDigest(row)) {
                if (accountId !== record.writerAccountId || !this.options.db.refreshProjection || this.exactThreadCensus(row.threadId, accountId) !== "clear")
                    return "collision";
                const identity = pinnedRolloutIdentity(this.accounts.get(accountId), row.rolloutPath, row.threadId);
                if (!identity)
                    return { accountId, row };
                this.mutate((next) => {
                    const current = next.threads[row.threadId];
                    current.projections[accountId] = { state: "committed", targetPath: row.rolloutPath, rolloutIdentity: identity, rowDigest: rowDigest(row) };
                    if (accountId === current.originAccountId) {
                        current.sourceRolloutIdentity = identity;
                        current.sourceRowDigest = rowDigest(row);
                    }
                });
                continue;
            }
            const identity = pinnedRolloutIdentity(this.accounts.get(accountId), row.rolloutPath, row.threadId);
            if (!identity) {
                return { accountId, row };
            }
            if (!sameIdentity(projection.rolloutIdentity, identity))
                return "collision";
        }
        return "ready";
    }
    async ensureProjection(threadId, targetAccountId) {
        const record = this.document.threads[threadId];
        const target = this.accounts.get(targetAccountId);
        const source = record ? this.accounts.get(record.writerAccountId) : null;
        if (!record || !target || !source || target.accountId === source.accountId || this.hasThreadCollision(record))
            return "collision";
        const sourceCensus = this.exactThreadCensus(threadId, source.accountId);
        const targetCensus = this.exactThreadCensus(threadId, target.accountId);
        if (sourceCensus !== "clear" || targetCensus !== "clear") {
            return sourceCensus === "conflict" || targetCensus === "conflict" ? "busy" : "unavailable";
        }
        let sourceRow;
        try {
            sourceRow = await this.options.db.readExact(databasePath(source), threadId);
        }
        catch {
            return "unavailable";
        }
        if (!sourceRow || !eligibleRow(sourceRow) || rowDigest(sourceRow) !== record.projections[record.writerAccountId]?.rowDigest) {
            this.markThreadCollision(threadId);
            return "collision";
        }
        const sourceIdentity = pinnedRolloutIdentity(source, sourceRow.rolloutPath, threadId);
        if (!sourceIdentity || !sameIdentity(sourceIdentity, record.projections[record.writerAccountId]?.rolloutIdentity)) {
            this.markThreadCollision(threadId);
            return "collision";
        }
        const expectedTargetPath = targetRolloutPath(source, target, sourceRow.rolloutPath, threadId);
        if (!expectedTargetPath) {
            this.markThreadCollision(threadId);
            return "collision";
        }
        let projection = record.projections[targetAccountId];
        if (!projection) {
            this.mutate((next) => {
                const current = next.threads[threadId];
                if (!current || current.projections[targetAccountId])
                    throw new Error("native projection changed during intent");
                current.projections[targetAccountId] = {
                    state: "intent",
                    targetPath: expectedTargetPath,
                    rolloutIdentity: { ...sourceIdentity },
                    rowDigest: rowDigestWithPath(sourceRow, expectedTargetPath),
                };
            });
            projection = this.document.threads[threadId].projections[targetAccountId];
        }
        if (projection.targetPath !== expectedTargetPath || !sameIdentity(projection.rolloutIdentity, sourceIdentity)
            || projection.rowDigest !== rowDigestWithPath(sourceRow, expectedTargetPath)) {
            this.markThreadCollision(threadId);
            return "collision";
        }
        if (projection.state === "collision")
            return "collision";
        if (projection.state === "committed") {
            return await this.projectionDatabaseExact(target, sourceRow, projection) ? "already" : this.projectionCollision(threadId);
        }
        if (projection.state === "intent") {
            const publication = publishRolloutHardLink(source, target, sourceRow.rolloutPath, threadId, sourceIdentity);
            if (publication.state !== "ready")
                return publication.state === "collision" ? this.projectionCollision(threadId) : "unavailable";
            const publicationPath = publication.path;
            const publicationIdentity = publication.identity;
            if (!publicationPath || !publicationIdentity)
                return this.projectionCollision(threadId);
            this.mutate((next) => {
                const current = next.threads[threadId]?.projections[targetAccountId];
                if (!current || current.state !== "intent")
                    throw new Error("native projection intent changed during link");
                current.state = "linked";
                current.targetPath = publicationPath;
                current.rolloutIdentity = { ...publicationIdentity };
            });
            projection = this.document.threads[threadId].projections[targetAccountId];
        }
        if (projection.state === "linked") {
            if (!nativeRolloutFileHasIdentity(projection.targetPath, projection.rolloutIdentity))
                return this.projectionCollision(threadId);
            let inserted;
            try {
                inserted = await this.options.db.insertProjection({
                    sourceDbPath: databasePath(source),
                    targetDbPath: databasePath(target),
                    source: sourceRow,
                    targetPath: projection.targetPath,
                });
            }
            catch {
                return "unavailable";
            }
            if (inserted === "conflict")
                return this.projectionCollision(threadId);
            if (!await this.projectionDatabaseExact(target, sourceRow, projection))
                return this.projectionCollision(threadId);
            this.mutate((next) => {
                const current = next.threads[threadId]?.projections[targetAccountId];
                if (!current || current.state !== "linked")
                    throw new Error("native projection link changed during catalog insert");
                current.state = "cataloged";
            });
            projection = this.document.threads[threadId].projections[targetAccountId];
        }
        if (projection.state === "cataloged") {
            if (!await this.projectionDatabaseExact(target, sourceRow, projection))
                return this.projectionCollision(threadId);
            this.mutate((next) => {
                const current = next.threads[threadId]?.projections[targetAccountId];
                if (!current || current.state !== "cataloged")
                    throw new Error("native projection catalog state changed during commit");
                current.state = "committed";
            });
            return "projected";
        }
        return "collision";
    }
    async projectionDatabaseExact(target, source, projection) {
        if (!nativeRolloutFileHasIdentity(projection.targetPath, projection.rolloutIdentity))
            return false;
        try {
            const row = await this.options.db.readExact(databasePath(target), source.threadId);
            return Boolean(row && eligibleRow(row) && row.rolloutPath === projection.targetPath
                && rowDigest(row) === projection.rowDigest && stableRowsEqual(source, row));
        }
        catch {
            return false;
        }
    }
    projectionCollision(threadId) {
        this.markThreadCollision(threadId);
        return "collision";
    }
    markThreadCollision(threadId) {
        const record = this.document.threads[threadId];
        if (!record || Object.values(record.projections).every((projection) => projection.state === "collision"))
            return;
        this.mutate((next) => {
            const current = next.threads[threadId];
            if (!current)
                return;
            for (const projection of Object.values(current.projections))
                projection.state = "collision";
        });
    }
    hasThreadCollision(record) {
        return Object.values(record.projections).some((projection) => projection.state === "collision");
    }
    hasUnsettledOperation(threadId) {
        return Object.values(this.document.operations).some((operation) => operation.threadId === threadId
            && operation.phase !== "owner_committed" && operation.phase !== "source_owned");
    }
    updateOperation(operationId, phase) {
        this.mutate((next) => {
            const operation = next.operations[operationId];
            if (!operation)
                throw new Error("unknown native transfer operation");
            operation.phase = phase;
            operation.updatedAt = this.timestamp();
        });
    }
    timestamp() {
        const value = this.now();
        if (!(value instanceof Date) || Number.isNaN(value.getTime()))
            throw new Error("native transfer clock is invalid");
        return value.toISOString();
    }
    mutate(mutator) {
        const next = structuredClone(this.document);
        mutator(next);
        if (!validDocument(next, this.accountIds))
            throw new Error("native catalog refused invalid durable state");
        this.persist(next);
        this.document = next;
    }
    ensureMinimumReaderMarker(publish = true) {
        const path = (0, node_path_1.join)(this.options.stateRoot, exports.NATIVE_TRANSFER_MINIMUM_RUNTIME_FILE_V2);
        if ((0, node_fs_1.existsSync)(path)) {
            (0, state_store_1.assertPrivateRegularFile)(path, 1024);
            const marker = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
            if (!(0, types_1.isPlainRecord)(marker) || inspectNativeTransferCompatibilityV2(marker, exports.ACCOUNTS_TRANSFER_READER_VERSION).state !== "compatible")
                throw new Error("native transfer reader is incompatible");
            return;
        }
        if (!publish)
            throw new Error("native transfer minimum reader marker is missing");
        (0, state_store_1.writePrivateJsonAtomicBounded)(this.options.stateRoot, exports.NATIVE_TRANSFER_MINIMUM_RUNTIME_FILE_V2, { version: 1, minimumTransferVersion: 2 }, 1024);
    }
    persist(document) {
        if (document.version === 1 && (0, node_fs_1.existsSync)((0, node_path_1.join)(this.options.stateRoot, exports.NATIVE_CATALOG_JOURNAL_FILE_V1))) {
            const prior = readJournalFile(this.options.stateRoot, this.accountIds);
            if (prior)
                throw new Error("legacy journal is retained until verified v2 migration");
        }
        const journal = { version: document.version, digest: documentDigest(document), document };
        // Journal first makes every intent visible across a crash. It is one
        // compact JSONL record, atomically replaced before the snapshot, then
        // cleared only after the snapshot replacement succeeds.
        (0, state_store_1.writePrivateJsonAtomicBounded)(this.options.stateRoot, document.version === 2 ? exports.NATIVE_CATALOG_JOURNAL_FILE_V2 : exports.NATIVE_CATALOG_JOURNAL_FILE_V1, journal, exports.NATIVE_CATALOG_MAX_BYTES_V1);
        (0, state_store_1.writePrivateJsonAtomicBounded)(this.options.stateRoot, document.version === 2 ? exports.NATIVE_CATALOG_FILE_V2 : exports.NATIVE_CATALOG_FILE_V1, document, exports.NATIVE_CATALOG_MAX_BYTES_V1);
        const journalPath = (0, node_path_1.join)(this.options.stateRoot, document.version === 2 ? exports.NATIVE_CATALOG_JOURNAL_FILE_V2 : exports.NATIVE_CATALOG_JOURNAL_FILE_V1);
        (0, node_fs_1.writeFileSync)(journalPath, "", { mode: PRIVATE_FILE_MODE });
        (0, node_fs_1.chmodSync)(journalPath, PRIVATE_FILE_MODE);
        (0, state_store_1.assertPrivateRegularFile)(journalPath, exports.NATIVE_CATALOG_MAX_BYTES_V1);
    }
    loadDocument() {
        const v2 = (0, node_fs_1.existsSync)((0, node_path_1.join)(this.options.stateRoot, exports.NATIVE_CATALOG_FILE_V2)) || (0, node_fs_1.existsSync)((0, node_path_1.join)(this.options.stateRoot, exports.NATIVE_CATALOG_JOURNAL_FILE_V2));
        if (v2)
            this.ensureMinimumReaderMarker(false);
        const file = v2 ? exports.NATIVE_CATALOG_FILE_V2 : exports.NATIVE_CATALOG_FILE_V1;
        const journalFile = v2 ? exports.NATIVE_CATALOG_JOURNAL_FILE_V2 : exports.NATIVE_CATALOG_JOURNAL_FILE_V1;
        const snapshot = readDocumentFile(this.options.stateRoot, file, this.accountIds);
        const journal = readJournalFile(this.options.stateRoot, this.accountIds, journalFile);
        if (!v2 && journal) {
            if (Object.values(journal.document.operations).some((operation) => operation.phase !== "owner_committed" && operation.phase !== "source_owned")
                || Object.values(journal.document.threads).some((thread) => Object.values(thread.projections).some((projection) => projection.state !== "committed"))
                || Object.values(journal.document.lockConversions).some((conversion) => conversion.phase !== "published" && conversion.phase !== "rolled_back")) {
                throw new Error("legacy native catalog journal requires verified recovery");
            }
            // A committed v1 journal is read, retained, and independently checked
            // against native rows before the first v2 migration. Never rewrite it.
            return journal.document;
        }
        if (journal && (!snapshot || documentDigest(snapshot) !== journal.digest)) {
            (0, state_store_1.writePrivateJsonAtomicBounded)(this.options.stateRoot, file, journal.document, exports.NATIVE_CATALOG_MAX_BYTES_V1);
            clearNativeCatalogJournal(this.options.stateRoot, journalFile);
            return journal.document;
        }
        if (journal)
            clearNativeCatalogJournal(this.options.stateRoot, journalFile);
        if (snapshot)
            return snapshot;
        if (journal)
            return journal.document;
        return { version: 1, threads: {}, operations: {}, lockConversions: {} };
    }
    exactThreadCensus(threadId, accountId) {
        if (typeof this.options.exactThreadCensus !== "function")
            return "unknown";
        try {
            const result = this.options.exactThreadCensus(threadId, accountId);
            if (result === true || result === "clear")
                return "clear";
            if (result === false || result === "conflict")
                return "conflict";
            return "unknown";
        }
        catch {
            return "unknown";
        }
    }
}
exports.NativeTransferCoordinatorV1 = NativeTransferCoordinatorV1;
function validAccount(value) {
    return (0, types_1.isPlainRecord)(value) && (0, types_1.isOpaqueAccountId)(value.accountId)
        && canonicalAbsolutePath(value.codexHome) && canonicalAbsolutePath(value.sqliteHome);
}
function accountHomeIdentities(account) {
    const codexHome = nativeAccountDirectoryIdentity(account.codexHome);
    const sqliteHome = nativeAccountDirectoryIdentity(account.sqliteHome);
    return codexHome && sqliteHome ? { codexHome, sqliteHome } : null;
}
function validCapability(value) {
    return (0, types_1.isPlainRecord)(value)
        && ((value.state === "ready" && value.writerLockProtocol === "shared_thread_writer_locks_v1" && value.paginatedHistory === true)
            || (value.state === "unsupported" && typeof value.reason === "string"
                && ["invalid_probe_input", "spawn_failed", "initialize_failed", "paginated_history_missing", "writer_lock_missing", "probe_timeout", "probe_failed"].includes(value.reason)));
}
function unsupportedCapability(reason) {
    return { state: "unsupported", reason };
}
/**
 * Executes a disposable, isolated app-server probe. It establishes that this
 * exact binary accepts paginated start and creates the documented per-thread
 * writer-lock object; version strings are deliberately not consulted.
 */
async function probeNativeTransferCapabilityV1(options) {
    if (!validProbeOptions(options))
        return unsupportedCapability("invalid_probe_input");
    const timeoutMs = validTimeout(options.timeoutMs) ? options.timeoutMs : SQLITE_TIMEOUT_MS;
    const spawnProcess = options.spawn ?? node_child_process_1.spawn;
    let probeRoot = null;
    let child = null;
    let client = null;
    try {
        probeRoot = (0, node_fs_1.realpathSync)((0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "tweakers-native-transfer-probe-")));
        (0, node_fs_1.chmodSync)(probeRoot, PRIVATE_DIRECTORY_MODE);
        const environment = {};
        for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
            if (typeof process.env[key] === "string")
                environment[key] = process.env[key];
        }
        const args = /^(?:codex|codex\.exe)$/.test((0, node_path_1.basename)(options.command)) ? ["app-server"] : [...options.args];
        child = spawnProcess(options.command, args, {
            cwd: probeRoot,
            // Keep the isolated probe from initiating any remote-control connection.
            // The native writer-lock and paginated-history checks do not require it.
            env: {
                ...environment,
                HOME: probeRoot,
                TMPDIR: probeRoot,
                TMP: probeRoot,
                TEMP: probeRoot,
                CODEX_HOME: probeRoot,
                CODEX_SQLITE_HOME: probeRoot,
                CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
            },
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        client = new NativeProbeClient(child);
        const run = async () => {
            const initialized = await client.request("initialize", {
                clientInfo: {
                    name: "tweakers-native-transfer-probe",
                    title: "Tweakers Native Transfer Probe",
                    version: "1.0.0",
                },
                capabilities: { experimentalApi: true },
            });
            if (explicitNativeError(initialized))
                throw new NativeProbeError("initialize_failed");
            client.notify("initialized", {});
            const started = await client.request("thread/start", { historyMode: "paginated" });
            const startInfo = probeThreadInfo(started);
            if (!startInfo.threadId)
                throw new NativeProbeError("paginated_history_missing");
            let historyMode = startInfo.historyMode;
            if (historyMode === null) {
                const read = await client.request("thread/read", { threadId: startInfo.threadId });
                if (explicitNativeError(read))
                    throw new NativeProbeError("paginated_history_missing");
                historyMode = probeThreadInfo(read).historyMode;
            }
            if (historyMode !== "paginated")
                throw new NativeProbeError("paginated_history_missing");
            const lockDirectory = (0, node_path_1.join)(probeRoot, "thread-writer-locks");
            const lockPath = (0, node_path_1.join)(lockDirectory, startInfo.threadId + ".lock");
            const lock = observedNativeWriterLock(lockPath, lockDirectory, probeRoot);
            if (!lock)
                throw new NativeProbeError("writer_lock_missing");
            return { state: "ready", writerLockProtocol: "shared_thread_writer_locks_v1", paginatedHistory: true };
        };
        return await probeWithTimeout(run(), timeoutMs);
    }
    catch (error) {
        if (error instanceof NativeProbeError)
            return unsupportedCapability(error.reason);
        return unsupportedCapability("probe_failed");
    }
    finally {
        client?.close();
        if (child)
            stopNativeProbeChild(child);
        if (probeRoot) {
            try {
                (0, node_fs_1.rmSync)(probeRoot, { recursive: true, force: true, maxRetries: 0 });
            }
            catch { /* private disposable probe root */ }
        }
    }
}
class NativeProbeError extends Error {
    reason;
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
class NativeProbeClient {
    child;
    pending = new Map();
    reader;
    nextId = 1;
    terminal = null;
    constructor(child) {
        this.child = child;
        if (!child.stdin || !child.stdout)
            throw new NativeProbeError("spawn_failed");
        let stdoutBytes = 0;
        child.stdout.on("data", (chunk) => {
            stdoutBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk, "utf8");
            if (stdoutBytes > SQLITE_MAX_OUTPUT_BYTES)
                this.fail(new NativeProbeError("probe_failed"));
        });
        // Probe stderr is private diagnostics. Consume it so an unexpected banner
        // cannot block the disposable child, but never surface it to callers.
        child.stderr?.resume();
        this.reader = (0, node_readline_1.createInterface)({ input: child.stdout });
        this.reader.on("line", (line) => this.receive(line));
        this.reader.once("close", () => this.fail(new NativeProbeError("probe_failed")));
        child.once("error", () => this.fail(new NativeProbeError("spawn_failed")));
        child.once("exit", () => this.fail(new NativeProbeError("probe_failed")));
    }
    request(method, params) {
        if (this.terminal)
            return Promise.reject(this.terminal);
        const id = this.nextId++;
        if (!Number.isSafeInteger(id) || id > 1_024)
            return Promise.reject(new NativeProbeError("probe_failed"));
        return new Promise((resolvePromise, rejectPromise) => {
            this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
            try {
                this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
                    if (error)
                        this.fail(new NativeProbeError("probe_failed"));
                });
            }
            catch {
                this.fail(new NativeProbeError("probe_failed"));
            }
        });
    }
    notify(method, params) {
        if (this.terminal)
            return;
        try {
            this.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
        }
        catch { /* probe cleanup handles loss */ }
    }
    close() {
        this.reader.close();
        this.fail(new NativeProbeError("probe_failed"));
    }
    receive(line) {
        if (line.length > 1_048_576) {
            this.fail(new NativeProbeError("probe_failed"));
            return;
        }
        let value;
        try {
            value = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!(0, types_1.isPlainRecord)(value) || !integer(value.id))
            return;
        const pending = this.pending.get(value.id);
        if (!pending)
            return;
        this.pending.delete(value.id);
        pending.resolve(value);
    }
    fail(error) {
        if (this.terminal)
            return;
        this.terminal = error;
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
    }
}
function validProbeOptions(value) {
    return (0, types_1.isPlainRecord)(value) && typeof value.command === "string" && value.command.length > 0 && value.command.length <= 4_096
        && !value.command.includes("\0") && Array.isArray(value.args) && value.args.length > 0 && value.args.length <= 64
        && value.args.every((argument) => typeof argument === "string" && argument.length <= 8_192 && !argument.includes("\0"))
        && value.args.includes("app-server")
        && (value.cwd === undefined || canonicalAbsolutePath(value.cwd))
        && (value.timeoutMs === undefined || validTimeout(value.timeoutMs))
        && (value.spawn === undefined || typeof value.spawn === "function");
}
function probeWithTimeout(value, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new NativeProbeError("probe_timeout")), timeoutMs);
        value.then((result) => { clearTimeout(timer); resolvePromise(result); }, (error) => { clearTimeout(timer); rejectPromise(error); });
    });
}
function probeThreadInfo(value) {
    const result = (0, types_1.isPlainRecord)(value) && Object.prototype.hasOwnProperty.call(value, "result") ? value.result : value;
    if (!(0, types_1.isPlainRecord)(result))
        return { threadId: null, historyMode: null };
    const thread = (0, types_1.isPlainRecord)(result.thread) ? result.thread : result;
    const id = thread.id ?? thread.threadId;
    const mode = thread.historyMode ?? thread.history_mode;
    return { threadId: validNativeThreadId(id) ? id : null, historyMode: typeof mode === "string" ? mode : null };
}
function stopNativeProbeChild(child) {
    if (child.exitCode !== null || child.killed)
        return;
    try {
        child.kill("SIGKILL");
    }
    catch { /* failed probe process has no authority outside its disposable home */ }
}
function unsupported(reason) {
    return { state: "unsupported", reason };
}
function unavailable(reason) {
    return { state: "unavailable", reason };
}
function busy(reason) {
    return { state: "busy", reason };
}
function collision(reason) {
    return { state: "collision", reason };
}
function assertPrivateDirectory(path) {
    if (!privateRealDirectoryIdentity(path))
        throw new Error("native catalog state root is unsafe");
}
function privateRealDirectoryIdentity(path) {
    try {
        if (!canonicalAbsolutePath(path) || (0, node_fs_1.realpathSync)(path) !== path)
            return null;
        const stat = (0, node_fs_1.lstatSync)(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
            || (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE || !safeIdentity(stat.dev, stat.ino))
            return null;
        return { dev: stat.dev, ino: stat.ino };
    }
    catch {
        return null;
    }
}
/**
 * Native Codex places `thread-writer-locks` directly below the sealed
 * CODEX_HOME. Current releases use 0755 for that child while legacy/current
 * Tweakers provisioning uses 0700. Both are accepted only below the signed,
 * owner-owned native home. Native homes may themselves be 0700 or 0755; no
 * accepted home or child is group- or world-writable. Broker catalog state
 * retains the strict 0700 requirement.
 */
function nativeWriterLockDirectoryIdentity(privateHome, path) {
    try {
        if (!canonicalAbsolutePath(privateHome) || !canonicalAbsolutePath(path)
            || (0, node_path_1.dirname)(path) !== privateHome || !nativeAccountDirectoryIdentity(privateHome))
            return null;
        const stat = (0, node_fs_1.lstatSync)(path);
        const mode = stat.mode & 0o777;
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
            || (mode !== PRIVATE_DIRECTORY_MODE && mode !== 0o755) || (mode & 0o022) !== 0
            || !safeIdentity(stat.dev, stat.ino))
            return null;
        return { dev: stat.dev, ino: stat.ino };
    }
    catch {
        return null;
    }
}
function nativeWriterLockDirectoryHasIdentity(privateHome, path, identity) {
    return sameIdentity(nativeWriterLockDirectoryIdentity(privateHome, path), identity);
}
function nativeRolloutFileIdentity(path) {
    try {
        if (!canonicalAbsolutePath(path))
            return null;
        const stat = (0, node_fs_1.lstatSync)(path);
        if (!safeNativeRolloutRegularStat(stat))
            return null;
        return { dev: stat.dev, ino: stat.ino };
    }
    catch {
        return null;
    }
}
/**
 * Codex currently creates zero-byte writer-lock files with mode 0644 in a
 * mode-0755 lock directory. Native homes are signed and owner-owned;
 * neither the home nor the lock namespace may be writable by other users.
 * Rejecting these existing modes would reject the installed native protocol.  The lock itself must still be an owned, non-symlink regular file
 * directly beneath that sealed home.
 */
function observedNativeWriterLock(path, lockDirectory, privateHome) {
    try {
        if (!canonicalAbsolutePath(path) || !canonicalAbsolutePath(lockDirectory) || !canonicalAbsolutePath(privateHome)
            || (0, node_path_1.dirname)(path) !== lockDirectory
            || !nativeWriterLockDirectoryIdentity(privateHome, lockDirectory))
            return null;
        const stat = (0, node_fs_1.lstatSync)(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
            || !safeIdentity(stat.dev, stat.ino))
            return null;
        return { dev: stat.dev, ino: stat.ino };
    }
    catch {
        return null;
    }
}
function safeIdentity(dev, ino) {
    return typeof dev === "number" && Number.isSafeInteger(dev) && dev >= 0
        && typeof ino === "number" && Number.isSafeInteger(ino) && ino >= 0;
}
function sameIdentity(left, right) {
    return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}
/** The only relaxed file mode is a native rollout under a sealed home. */
function nativeRolloutFileHasIdentity(path, identity) {
    try {
        const stat = (0, node_fs_1.lstatSync)(path);
        return safeNativeRolloutRegularStat(stat)
            && stat.dev === identity.dev && stat.ino === identity.ino;
    }
    catch {
        return false;
    }
}
function writerLockPath(account) {
    return (0, node_path_1.join)(account.codexHome, "thread-writer-locks");
}
function databasePath(account) {
    return (0, node_path_1.join)(account.sqliteHome, "state_5.sqlite");
}
function exactWriterLockSymlink(path, primaryPath, primaryIdentity) {
    try {
        const stat = (0, node_fs_1.lstatSync)(path);
        if (!stat.isSymbolicLink())
            return false;
        const expected = (0, node_path_1.relative)((0, node_path_1.dirname)(path), primaryPath);
        if (!expected || (0, node_path_1.isAbsolute)(expected) || (0, node_fs_1.readlinkSync)(path) !== expected || (0, node_fs_1.realpathSync)(path) !== primaryPath)
            return false;
        return nativeWriterLockDirectoryHasIdentity((0, node_path_1.dirname)(primaryPath), primaryPath, primaryIdentity);
    }
    catch {
        return false;
    }
}
function publishWriterLockSymlink(path, primaryPath) {
    const relativeTarget = (0, node_path_1.relative)((0, node_path_1.dirname)(path), primaryPath);
    if (!relativeTarget || (0, node_path_1.isAbsolute)(relativeTarget) || (0, node_fs_1.existsSync)(path))
        throw new Error("writer lock projection target is unsafe");
    (0, node_fs_1.symlinkSync)(relativeTarget, path, "dir");
}
function validTransferInput(value) {
    return (0, types_1.isPlainRecord)(value) && validOperationId(value.operationId) && validNativeThreadId(value.threadId)
        && (0, types_1.isOpaqueAccountId)(value.sourceAccountId) && (0, types_1.isOpaqueAccountId)(value.targetAccountId)
        && value.sourceAccountId !== value.targetAccountId;
}
function sameOperation(operation, input) {
    return operation.operationId === input.operationId && operation.threadId === input.threadId
        && operation.sourceAccountId === input.sourceAccountId && operation.targetAccountId === input.targetAccountId;
}
function readyPrepare(operation) {
    if (!operation.targetPath)
        return { state: "collision" };
    return {
        state: "ready",
        operationId: operation.operationId,
        threadId: operation.threadId,
        targetPath: operation.targetPath,
        sourceAccountId: operation.sourceAccountId,
        targetAccountId: operation.targetAccountId,
    };
}
function provedSettlement(operation) {
    return operation.targetPath
        ? { state: "proved", operationId: operation.operationId, accountId: operation.targetAccountId, threadId: operation.threadId, path: operation.targetPath }
        : { state: "collision" };
}
function eligibleRow(row) {
    return validNativeThreadRow(row) && row.archived === 0 && (row.historyMode === "paginated" || row.historyMode === "legacy")
        && row.values.id === row.threadId && row.values.rollout_path === row.rolloutPath && row.values.history_mode === row.historyMode
        && STABLE_ROW_DIGEST_COLUMNS.every((column) => nativeSqlValue(row.values[column]));
}
function validPage(value) {
    return (0, types_1.isPlainRecord)(value) && Array.isArray(value.rows) && value.rows.length <= SQLITE_PAGE_SIZE
        && value.rows.every(validNativeThreadRow)
        && (value.nextCursor === null || ((0, types_1.isPlainRecord)(value.nextCursor) && integer(value.nextCursor.updatedAtMs) && validNativeThreadId(value.nextCursor.threadId)));
}
function rowDigest(row) {
    return digestStableRow(row, row.rolloutPath);
}
function rowDigestWithPath(row, path) {
    return digestStableRow(row, path);
}
function stableRowsEqual(source, target) {
    for (const column of STABLE_ROW_DIGEST_COLUMNS) {
        if (column === "rollout_path")
            continue;
        const sourceValue = source.values[column];
        const targetValue = target.values[column];
        if (sourceValue === undefined || targetValue === undefined || !sameSqlValue(sourceValue, targetValue))
            return false;
    }
    return source.threadId === target.threadId && source.historyMode === target.historyMode && source.archived === target.archived;
}
function digestStableRow(row, rolloutPath) {
    const values = {};
    for (const column of STABLE_ROW_DIGEST_COLUMNS) {
        const value = column === "rollout_path" ? rolloutPath : row.values[column];
        if (value === undefined)
            throw new Error("native row lacks a stable required value");
        values[column] = value;
    }
    return "sha256:" + (0, node_crypto_1.createHash)("sha256").update(canonicalJson(values), "utf8").digest("hex");
}
function pinnedRolloutIdentity(account, rolloutPath, threadId) {
    const suffix = rolloutRelativeSuffix(account, rolloutPath, threadId);
    if (!suffix || !safeNativeRolloutDirectoryChain(account.codexHome, (0, node_path_1.dirname)(rolloutPath)))
        return null;
    let descriptor;
    try {
        const before = nativeRolloutFileStat(rolloutPath);
        if (!before)
            return null;
        descriptor = (0, node_fs_1.openSync)(rolloutPath, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
        const opened = (0, node_fs_1.fstatSync)(descriptor);
        if (!safeNativeRolloutRegularStat(opened) || opened.size > exports.NATIVE_TRANSFER_MAX_ROLLOUT_BYTES_V1
            || opened.dev !== before.dev || opened.ino !== before.ino)
            return null;
        // The open descriptor pins the source object. Re-reading the pathname is
        // still necessary because link(2) below takes a pathname, not an fd.
        const after = nativeRolloutFileStat(rolloutPath);
        if (!after || after.dev !== before.dev || after.ino !== before.ino
            || after.size !== before.size)
            return null;
        return { dev: opened.dev, ino: opened.ino };
    }
    catch {
        return null;
    }
    finally {
        if (descriptor !== undefined) {
            try {
                (0, node_fs_1.closeSync)(descriptor);
            }
            catch { /* descriptor is already unusable */ }
        }
    }
}
function targetRolloutPath(source, target, sourcePath, threadId) {
    const suffix = rolloutRelativeSuffix(source, sourcePath, threadId);
    if (!suffix)
        return null;
    const path = (0, node_path_1.join)(target.codexHome, "sessions", ...suffix);
    return canonicalAbsolutePath(path) ? path : null;
}
function rolloutRelativeSuffix(account, rolloutPath, threadId) {
    if (!canonicalAbsolutePath(rolloutPath) || !validNativeThreadId(threadId))
        return null;
    const sessionsRoot = (0, node_path_1.join)(account.codexHome, "sessions");
    const relativePath = (0, node_path_1.relative)(sessionsRoot, rolloutPath);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(".." + "/") || (0, node_path_1.isAbsolute)(relativePath))
        return null;
    const parts = relativePath.split("/");
    if (parts.length !== 4 || !/^\d{4}$/.test(parts[0]) || !/^\d{2}$/.test(parts[1]) || !/^\d{2}$/.test(parts[2]))
        return null;
    const name = parts[3];
    const exactName = name === threadId + ".jsonl";
    const rolloutName = name.startsWith("rollout-") && name.endsWith("-" + threadId + ".jsonl");
    const continuationName = new RegExp("^(?:rollout-.*-)?" + threadId + "_[a-f0-9-]{36}\\.jsonl$").test(name);
    if (!(exactName || rolloutName || continuationName) || name.length > 1_024)
        return null;
    return parts;
}
function publishRolloutHardLink(source, target, sourcePath, threadId, sourceIdentity) {
    const targetPath = targetRolloutPath(source, target, sourcePath, threadId);
    if (!targetPath || !sameIdentity(pinnedRolloutIdentity(source, sourcePath, threadId), sourceIdentity)) {
        return { state: "collision" };
    }
    const parentPath = (0, node_path_1.dirname)(targetPath);
    const parentBefore = ensurePrivateTargetRolloutParent(target, targetPath, threadId);
    if (!parentBefore)
        return { state: "collision" };
    let created = false;
    let createdIdentity = null;
    try {
        try {
            (0, node_fs_1.linkSync)(sourcePath, targetPath);
            created = true;
            createdIdentity = nativeRolloutFileIdentity(targetPath);
            if (!sameIdentity(createdIdentity, sourceIdentity)) {
                unlinkExactNativeRollout(targetPath, createdIdentity);
                return { state: "collision" };
            }
        }
        catch (error) {
            if (error.code === "EEXIST") {
                // An existing target is valid only when it is already the exact
                // pinned source inode. It may have been published by a prior crash.
                if (!nativeRolloutFileHasIdentity(targetPath, sourceIdentity))
                    return { state: "collision" };
            }
            else if (error.code === "EXDEV") {
                return { state: "unavailable" };
            }
            else {
                return { state: "unavailable" };
            }
        }
        const parentAfter = nativeAccountDirectoryIdentity(parentPath);
        const sourceAfter = pinnedRolloutIdentity(source, sourcePath, threadId);
        if (!sameIdentity(parentBefore, parentAfter) || !sameIdentity(sourceAfter, sourceIdentity)
            || !nativeRolloutFileHasIdentity(targetPath, sourceIdentity)
            || !safeNativeRolloutDirectoryChain(target.codexHome, parentPath)) {
            if (created)
                unlinkExactNativeRollout(targetPath, createdIdentity);
            return { state: "collision" };
        }
        return { state: "ready", path: targetPath, identity: sourceIdentity };
    }
    catch {
        if (created)
            unlinkExactNativeRollout(targetPath, createdIdentity);
        return { state: "collision" };
    }
}
function ensurePrivateTargetRolloutParent(target, targetPath, threadId) {
    const suffix = rolloutRelativeSuffix(target, targetPath, threadId);
    if (!suffix || !nativeAccountDirectoryIdentity(target.codexHome))
        return null;
    let current = target.codexHome;
    // `sessions` and the date path are the only directories this module may
    // create. It never creates arbitrary path components from SQLite data.
    for (const component of ["sessions", ...suffix.slice(0, 3)]) {
        const child = (0, node_path_1.join)(current, component);
        try {
            let stat;
            try {
                stat = (0, node_fs_1.lstatSync)(child);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    return null;
                (0, node_fs_1.mkdirSync)(child, { mode: PRIVATE_DIRECTORY_MODE });
                (0, node_fs_1.chmodSync)(child, PRIVATE_DIRECTORY_MODE);
                stat = (0, node_fs_1.lstatSync)(child);
            }
            if (!nativeAccountDirectoryIdentity(child))
                return null;
            current = child;
        }
        catch {
            return null;
        }
    }
    return nativeAccountDirectoryIdentity(current);
}
function safeNativeRolloutDirectoryChain(root, end) {
    if (!canonicalAbsolutePath(root) || !canonicalAbsolutePath(end) || !nativeAccountDirectoryIdentity(root))
        return false;
    const relativePath = (0, node_path_1.relative)(root, end);
    if (relativePath === ".." || relativePath.startsWith(".." + "/") || (0, node_path_1.isAbsolute)(relativePath))
        return false;
    let current = root;
    if (!relativePath)
        return true;
    const components = relativePath.split("/");
    if (components[0] !== "sessions" && components[0] !== "archived_sessions")
        return false;
    for (const component of components) {
        if (!component || component === "." || component === "..")
            return false;
        current = (0, node_path_1.join)(current, component);
        if (!nativeAccountDirectoryIdentity(current))
            return false;
    }
    return true;
}
/**
 * Native account homes and their session/archive trees use 0700 or 0755.
 * Accept those existing owner-owned modes without chmodding a live home;
 * neither may be writable by group or world. Broker-private state uses the
 * separate strict privateRealDirectoryIdentity check.
 */
function nativeAccountDirectoryIdentity(path) {
    try {
        if (!canonicalAbsolutePath(path) || (0, node_fs_1.realpathSync)(path) !== path)
            return null;
        const stat = (0, node_fs_1.lstatSync)(path);
        const mode = stat.mode & 0o777;
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
            || (mode !== PRIVATE_DIRECTORY_MODE && mode !== 0o755) || (mode & 0o022) !== 0
            || !safeIdentity(stat.dev, stat.ino))
            return null;
        return { dev: stat.dev, ino: stat.ino };
    }
    catch {
        return null;
    }
}
function nativeRolloutFileStat(path) {
    try {
        const stat = (0, node_fs_1.lstatSync)(path);
        return safeNativeRolloutRegularStat(stat) && stat.size <= exports.NATIVE_TRANSFER_MAX_ROLLOUT_BYTES_V1 ? stat : null;
    }
    catch {
        return null;
    }
}
/** Native rollout files may be Codex-created 0644 beneath a sealed home. */
function safeNativeRolloutRegularStat(stat) {
    if (!stat)
        return false;
    const mode = stat.mode & 0o777;
    return stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
        && (mode === PRIVATE_FILE_MODE || mode === 0o644) && (mode & 0o022) === 0
        && Number.isSafeInteger(stat.size) && stat.size >= 0
        && safeIdentity(stat.dev, stat.ino);
}
function unlinkExactNativeRollout(path, identity) {
    if (!identity || !nativeRolloutFileHasIdentity(path, identity))
        return false;
    try {
        // Re-check just before unlink so a pathname replacement remains retained.
        if (!nativeRolloutFileHasIdentity(path, identity))
            return false;
        (0, node_fs_1.unlinkSync)(path);
        return true;
    }
    catch {
        return false;
    }
}
function explicitNativeError(value) {
    return (0, types_1.isPlainRecord)(value) && (0, types_1.isPlainRecord)(value.error)
        && typeof value.error.code === "number" && typeof value.error.message === "string";
}
function matchingResumeResponse(value, operation) {
    const result = (0, types_1.isPlainRecord)(value) && (0, types_1.isPlainRecord)(value.result) ? value.result : value;
    if (!(0, types_1.isPlainRecord)(result))
        return null;
    const thread = (0, types_1.isPlainRecord)(result.thread) ? result.thread : result;
    const threadId = thread.id ?? thread.threadId;
    const path = thread.path ?? thread.rolloutPath;
    if (threadId !== operation.threadId || path !== operation.targetPath || !canonicalAbsolutePath(path))
        return null;
    return { path };
}
function validLoadedMap(value, accountIds) {
    if (!(value instanceof Map) || value.size !== accountIds.size)
        return false;
    for (const accountId of accountIds) {
        const threads = value.get(accountId);
        if (!Array.isArray(threads) || threads.length > exports.NATIVE_CATALOG_MAX_THREADS_V1)
            return false;
        const seen = new Set();
        for (const loaded of threads) {
            if (!(0, types_1.isPlainRecord)(loaded) || !validNativeThreadId(loaded.threadId)
                || !(loaded.path === undefined || loaded.path === null || canonicalAbsolutePath(loaded.path))
                || seen.has(loaded.threadId))
                return false;
            seen.add(loaded.threadId);
        }
    }
    for (const accountId of value.keys())
        if (!accountIds.has(accountId))
            return false;
    return true;
}
function loadedAccountsForThread(loadedByAccount, threadId) {
    const accounts = [];
    for (const [accountId, loaded] of loadedByAccount) {
        if (loaded.some((entry) => entry.threadId === threadId))
            accounts.push(accountId);
    }
    return accounts;
}
function canonicalJson(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "[" + value.map(canonicalJson).join(",") + "]";
    if ((0, types_1.isPlainRecord)(value)) {
        return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
    }
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string")
        throw new Error("native catalog cannot canonicalize value");
    return encoded;
}
function documentDigest(document) {
    return "sha256:" + (0, node_crypto_1.createHash)("sha256").update(canonicalJson(document), "utf8").digest("hex");
}
function readDocumentFile(root, fileName, accountIds) {
    const path = (0, node_path_1.join)(root, fileName);
    if (!(0, node_fs_1.existsSync)(path))
        return null;
    try {
        (0, state_store_1.assertPrivateRegularFile)(path, exports.NATIVE_CATALOG_MAX_BYTES_V1);
        const bytes = (0, node_fs_1.readFileSync)(path, "utf8");
        if (Buffer.byteLength(bytes, "utf8") > exports.NATIVE_CATALOG_MAX_BYTES_V1)
            throw new Error("oversized native catalog");
        const value = JSON.parse(bytes);
        if (!validDocument(value, accountIds))
            throw new Error("invalid native catalog");
        return value;
    }
    catch {
        throw new Error("native catalog snapshot is invalid");
    }
}
function readJournalFile(root, accountIds, file = exports.NATIVE_CATALOG_JOURNAL_FILE_V1) {
    const path = (0, node_path_1.join)(root, file);
    if (!(0, node_fs_1.existsSync)(path))
        return null;
    try {
        (0, state_store_1.assertPrivateRegularFile)(path, exports.NATIVE_CATALOG_MAX_BYTES_V1);
        const bytes = (0, node_fs_1.readFileSync)(path, "utf8");
        if (Buffer.byteLength(bytes, "utf8") > exports.NATIVE_CATALOG_MAX_BYTES_V1)
            throw new Error("oversized native catalog journal");
        const lines = bytes.trim().split("\n").filter(Boolean);
        if (lines.length === 0)
            return null;
        if (lines.length !== 1)
            throw new Error("ambiguous native catalog journal");
        const value = JSON.parse(lines[0]);
        if (!validJournal(value, accountIds) || value.digest !== documentDigest(value.document))
            throw new Error("invalid native catalog journal");
        return value;
    }
    catch {
        throw new Error("native catalog journal is invalid");
    }
}
function clearNativeCatalogJournal(root, file = exports.NATIVE_CATALOG_JOURNAL_FILE_V1) {
    const path = (0, node_path_1.join)(root, file);
    if ((0, node_fs_1.existsSync)(path))
        (0, state_store_1.assertPrivateRegularFile)(path, exports.NATIVE_CATALOG_MAX_BYTES_V1);
    (0, node_fs_1.writeFileSync)(path, "", { mode: PRIVATE_FILE_MODE });
    (0, node_fs_1.chmodSync)(path, PRIVATE_FILE_MODE);
    (0, state_store_1.assertPrivateRegularFile)(path, exports.NATIVE_CATALOG_MAX_BYTES_V1);
}
function validJournal(value, accountIds) {
    return (0, types_1.isPlainRecord)(value) && exactKeys(value, ["digest", "document", "version"])
        && (value.version === 1 || value.version === 2) && validDigest(value.digest) && validDocument(value.document, accountIds);
}
function validDocument(value, accountIds) {
    if (!(0, types_1.isPlainRecord)(value) || !exactKeys(value, ["lockConversions", "operations", "threads", "version"])
        || (value.version !== 1 && value.version !== 2) || !(0, types_1.isPlainRecord)(value.threads)
        || !(0, types_1.isPlainRecord)(value.operations) || !(0, types_1.isPlainRecord)(value.lockConversions))
        return false;
    const threadEntries = Object.entries(value.threads);
    const operationEntries = Object.entries(value.operations);
    const lockEntries = Object.entries(value.lockConversions);
    if (threadEntries.length > exports.NATIVE_CATALOG_MAX_THREADS_V1 || operationEntries.length > MAX_OPERATIONS
        || lockEntries.length > MAX_LOCK_CONVERSIONS)
        return false;
    return threadEntries.every(([threadId, record]) => validCatalogThread(threadId, record, accountIds))
        && operationEntries.every(([operationId, operation]) => validOperation(operationId, operation, accountIds))
        && lockEntries.every(([accountId, record]) => validLockConversion(accountId, record, accountIds));
}
function validCatalogThread(key, value, accountIds) {
    if (!(0, types_1.isPlainRecord)(value) || !exactKeys(value, ["originAccountId", "projections", "sourceRolloutIdentity", "sourceRowDigest", "threadId", "writerAccountId"])
        || !validNativeThreadId(key) || value.threadId !== key || !isKnownCatalogAccount(value.originAccountId, accountIds)
        || !isKnownCatalogAccount(value.writerAccountId, accountIds) || !validIdentity(value.sourceRolloutIdentity)
        || !validDigest(value.sourceRowDigest) || !(0, types_1.isPlainRecord)(value.projections))
        return false;
    const projections = Object.entries(value.projections);
    if (projections.length < 1 || projections.length > accountIds.size)
        return false;
    if (!projections.every(([accountId, projection]) => isKnownCatalogAccount(accountId, accountIds)
        && validProjection(projection)))
        return false;
    const typedProjections = value.projections;
    const origin = typedProjections[value.originAccountId];
    const writer = typedProjections[value.writerAccountId];
    if (projections.some(([, projection]) => projection.state === "collision")) {
        return projections.every(([, projection]) => projection.state === "collision");
    }
    return Boolean(origin && writer && origin.state === "committed" && writer.state === "committed"
        && sameIdentity(origin.rolloutIdentity, value.sourceRolloutIdentity) && origin.rowDigest === value.sourceRowDigest);
}
function validProjection(value) {
    return (0, types_1.isPlainRecord)(value) && exactKeys(value, ["rolloutIdentity", "rowDigest", "state", "targetPath"])
        && (value.state === "intent" || value.state === "linked" || value.state === "cataloged" || value.state === "committed" || value.state === "collision")
        && canonicalAbsolutePath(value.targetPath) && validIdentity(value.rolloutIdentity) && validDigest(value.rowDigest);
}
function validOperation(key, value, accountIds) {
    if (!(0, types_1.isPlainRecord)(value) || !exactKeys(value, ["operationId", "phase", "sourceAccountId", "targetAccountId", "targetIdentity", "targetPath", "threadId", "updatedAt", ...(value.generation === undefined ? [] : ["generation"]), ...(value.transferVersion === undefined ? [] : ["transferVersion"]), ...(value.writerLock === undefined ? [] : ["writerLock"])])
        || !validOperationId(key) || value.operationId !== key || !validNativeThreadId(value.threadId)
        || !isKnownCatalogAccount(value.sourceAccountId, accountIds) || !isKnownCatalogAccount(value.targetAccountId, accountIds)
        || value.sourceAccountId === value.targetAccountId || !validCatalogTimestamp(value.updatedAt)
        || !(value.phase === "preparing" || value.phase === "target_prepared" || value.phase === "resume_dispatching"
            || value.phase === "target_resumed" || value.phase === "owner_committed" || value.phase === "source_owned"
            || value.phase === "ambiguous" || value.phase === "collision"))
        return false;
    if (value.writerLock !== undefined && (!(0, types_1.isPlainRecord)(value.writerLock) || !exactKeys(value.writerLock, ["dev", "ino"])
        || typeof value.writerLock.dev !== "string" || !/^[0-9]+$/.test(value.writerLock.dev)
        || typeof value.writerLock.ino !== "string" || !/^[0-9]+$/.test(value.writerLock.ino)))
        return false;
    if (value.transferVersion !== undefined && value.transferVersion !== 2)
        return false;
    if (value.generation !== undefined && !validGenerationV2(value.generation))
        return false;
    const targetPresent = canonicalAbsolutePath(value.targetPath) && validIdentity(value.targetIdentity);
    return ((value.phase === "preparing" || value.phase === "source_owned" && value.transferVersion === 2) && value.targetPath === null && value.targetIdentity === null)
        || (value.phase !== "preparing" && targetPresent);
}
function validLockConversion(key, value, accountIds) {
    return (0, types_1.isPlainRecord)(value) && exactKeys(value, ["accountId", "expectedCanonicalIdentity", "oldIdentity", "phase", "timestamp"])
        && key === value.accountId && isKnownCatalogAccount(value.accountId, accountIds)
        && (value.oldIdentity === null || validIdentity(value.oldIdentity)) && validIdentity(value.expectedCanonicalIdentity)
        && (value.phase === "intent" || value.phase === "moved" || value.phase === "published" || value.phase === "rolled_back" || value.phase === "collision")
        && validCatalogTimestamp(value.timestamp);
}
function isKnownCatalogAccount(value, accountIds) {
    return (0, types_1.isOpaqueAccountId)(value) && accountIds.has(value);
}
function validIdentity(value) {
    return (0, types_1.isPlainRecord)(value) && exactKeys(value, ["dev", "ino"]) && safeIdentity(value.dev, value.ino);
}
function validDigest(value) {
    return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
function validCatalogTimestamp(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
/**
 * Read-only cold-start inventory for continuity restoration. A nonempty
 * journal is intentionally ambiguous here: this function must never repair
 * or promote an interrupted owner transition while the broker is closed.
 */
function readCommittedNativeThreadInventoryV1(options) {
    if (!(0, types_1.isPlainRecord)(options) || !canonicalAbsolutePath(options.stateRoot)) {
        return { state: "unavailable", reason: "invalid_input" };
    }
    if (!privateRealDirectoryIdentity(options.stateRoot)) {
        return { state: "unavailable", reason: "state_root_invalid" };
    }
    const v2 = (0, node_fs_1.existsSync)((0, node_path_1.join)(options.stateRoot, exports.NATIVE_CATALOG_FILE_V2)) || (0, node_fs_1.existsSync)((0, node_path_1.join)(options.stateRoot, exports.NATIVE_CATALOG_JOURNAL_FILE_V2));
    const snapshotPath = (0, node_path_1.join)(options.stateRoot, v2 ? exports.NATIVE_CATALOG_FILE_V2 : exports.NATIVE_CATALOG_FILE_V1);
    const journalPath = (0, node_path_1.join)(options.stateRoot, v2 ? exports.NATIVE_CATALOG_JOURNAL_FILE_V2 : exports.NATIVE_CATALOG_JOURNAL_FILE_V1);
    try {
        if ((0, node_fs_1.existsSync)(journalPath)) {
            (0, state_store_1.assertPrivateRegularFile)(journalPath, exports.NATIVE_CATALOG_MAX_BYTES_V1);
            const journal = (0, node_fs_1.readFileSync)(journalPath, "utf8");
            if (Buffer.byteLength(journal, "utf8") > exports.NATIVE_CATALOG_MAX_BYTES_V1 || journal.trim().length > 0) {
                return { state: "unavailable", reason: "journal_ambiguous" };
            }
        }
        if (!(0, node_fs_1.existsSync)(snapshotPath))
            return { state: "unavailable", reason: "snapshot_missing" };
        (0, state_store_1.assertPrivateRegularFile)(snapshotPath, exports.NATIVE_CATALOG_MAX_BYTES_V1);
        const bytes = (0, node_fs_1.readFileSync)(snapshotPath, "utf8");
        if (Buffer.byteLength(bytes, "utf8") > exports.NATIVE_CATALOG_MAX_BYTES_V1)
            return { state: "unavailable", reason: "snapshot_invalid" };
        const candidate = JSON.parse(bytes);
        const accountIds = inferredCatalogAccountIds(candidate);
        if (!accountIds || !validDocument(candidate, accountIds))
            return { state: "unavailable", reason: "snapshot_invalid" };
        const document = candidate;
        const records = Object.values(document.threads);
        if (records.some((record) => Object.values(record.projections).some((projection) => projection.state === "collision"))) {
            return { state: "unavailable", reason: "catalog_collision" };
        }
        if (records.some((record) => Object.values(record.projections).some((projection) => projection.state !== "committed"))
            || Object.values(document.operations).some((operation) => operation.phase !== "owner_committed" && operation.phase !== "source_owned")) {
            return { state: "unavailable", reason: "catalog_transition_pending" };
        }
        const threadIds = Object.keys(document.threads).sort();
        const fingerprint = ("sha256:" + (0, node_crypto_1.createHash)("sha256")
            .update(canonicalJson({ version: 1, threadIds }), "utf8").digest("hex"));
        return { state: "ready", fingerprint, threadIds };
    }
    catch {
        return { state: "unavailable", reason: "snapshot_invalid" };
    }
}
function inferredCatalogAccountIds(value) {
    if (!(0, types_1.isPlainRecord)(value))
        return null;
    const ids = new Set();
    const add = (candidate) => {
        if (!(0, types_1.isOpaqueAccountId)(candidate))
            return false;
        ids.add(candidate);
        return true;
    };
    if ((0, types_1.isPlainRecord)(value.threads)) {
        for (const record of Object.values(value.threads)) {
            if (!(0, types_1.isPlainRecord)(record) || !add(record.originAccountId) || !add(record.writerAccountId) || !(0, types_1.isPlainRecord)(record.projections))
                return null;
            for (const accountId of Object.keys(record.projections))
                if (!add(accountId))
                    return null;
        }
    }
    if ((0, types_1.isPlainRecord)(value.operations)) {
        for (const operation of Object.values(value.operations)) {
            if (!(0, types_1.isPlainRecord)(operation) || !add(operation.sourceAccountId) || !add(operation.targetAccountId))
                return null;
        }
    }
    if ((0, types_1.isPlainRecord)(value.lockConversions)) {
        for (const record of Object.values(value.lockConversions)) {
            if (!(0, types_1.isPlainRecord)(record) || !add(record.accountId))
                return null;
        }
    }
    return ids;
}
function digestNativeStream(path) {
    const before = nativeRolloutFileStat(path);
    if (!before)
        throw new Error("unsafe stream");
    const descriptor = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
    try {
        const opened = (0, node_fs_1.fstatSync)(descriptor);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
            throw new Error("stream changed");
        const digest = "sha256:" + (0, node_crypto_1.createHash)("sha256").update((0, node_fs_1.readFileSync)(descriptor)).digest("hex");
        const after = (0, node_fs_1.fstatSync)(descriptor);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
            throw new Error("stream changed");
        return digest;
    }
    finally {
        (0, node_fs_1.closeSync)(descriptor);
    }
}
function validGenerationV2(value) {
    if (!(0, types_1.isPlainRecord)(value) || !exactKeys(value, ["row", "streams", "history", "digest"]) || !validNativeThreadRow(value.row)
        || !Array.isArray(value.streams) || !value.streams.length || value.streams.length > 1024 || !validDigest(value.digest))
        return false;
    if (!value.streams.every((stream) => (0, types_1.isPlainRecord)(stream) && exactKeys(stream, ["path", "streamId", "identity", "size", "digest"])
        && canonicalAbsolutePath(stream.path) && validNativeThreadId(stream.streamId) && validIdentity(stream.identity)
        && typeof stream.size === "number" && Number.isSafeInteger(stream.size) && stream.size >= 0 && stream.size <= exports.NATIVE_TRANSFER_MAX_ROLLOUT_BYTES_V1 && validDigest(stream.digest)))
        return false;
    if (value.history !== null) {
        if (!(0, types_1.isPlainRecord)(value.history) || !exactKeys(value.history, ["schema", "rows"]) || typeof value.history.schema !== "string"
            || !(0, types_1.isPlainRecord)(value.history.rows) || !exactKeys(value.history.rows, HISTORY_TABLES_V2))
            return false;
        for (const rows of Object.values(value.history.rows))
            if (!Array.isArray(rows) || rows.length > 100000 || !rows.every((row) => (0, types_1.isPlainRecord)(row)
                && Object.entries(row).every(([key, item]) => safeColumnName(key) && (item === null || typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))))))
                return false;
    }
    return value.digest === "sha256:" + (0, node_crypto_1.createHash)("sha256").update(canonicalJson({ row: value.row, streams: value.streams, history: value.history })).digest("hex");
}
//# sourceMappingURL=native-transfer.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeSourceRetirementStoreV2 = exports.ACCOUNTS_SOURCE_RETIREMENT_READER_VERSION = void 0;
exports.inspectNativeSourceRetirementCompatibilityV2 = inspectNativeSourceRetirementCompatibilityV2;
const node_fs_1 = require("node:fs");
const node_crypto_1 = require("node:crypto");
const node_path_1 = require("node:path");
const state_store_1 = require("./state-store");
const types_1 = require("./types");
const DIRECTORY = "native-source-retirements.v2";
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_STREAMS = 1024;
const MAX_STREAM_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const THREAD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
exports.ACCOUNTS_SOURCE_RETIREMENT_READER_VERSION = 2;
/** Explicit capability surfaced by the fingerprint-bound installed reader. */
function inspectNativeSourceRetirementCompatibilityV2(candidateVersion) {
    return { state: candidateVersion === exports.ACCOUNTS_SOURCE_RETIREMENT_READER_VERSION ? "compatible" : "incompatible", minimumVersion: 2 };
}
/**
 * Source retirement never changes owner or restores a saved generation. Its
 * independent snapshots survive successful return transfers and ambiguous
 * interruptions. Native homes contain neither receipts nor recovery copies.
 */
class NativeSourceRetirementStoreV2 {
    stateRoot;
    accounts;
    db;
    constructor(stateRoot, accounts, db) {
        this.stateRoot = stateRoot;
        this.accounts = accounts;
        this.db = db;
    }
    noteCommittedTransfer(threadId, operationId, sourceAccountId) {
        const index = this.readIndex();
        index.latestByThread[threadId] = operationId;
        index.latestOutgoingByProjection[projectionKey(threadId, sourceAccountId)] = operationId;
        this.writeIndex(index);
    }
    invalidateProjection(threadId, accountId) {
        const index = this.readIndex();
        const key = projectionKey(threadId, accountId);
        if (index.activeByProjection[key] === undefined)
            return;
        index.activeByProjection[key] = null;
        this.writeIndex(index);
    }
    latestOperation(threadId) {
        try {
            return this.readIndex().latestByThread[threadId] ?? null;
        }
        catch {
            return null;
        }
    }
    activeOperation(threadId, accountId) {
        try {
            return this.readIndex().activeByProjection[projectionKey(threadId, accountId)] ?? null;
        }
        catch {
            return null;
        }
    }
    latestOutgoingOperation(threadId, accountId) {
        return this.readIndex().latestOutgoingByProjection[projectionKey(threadId, accountId)] ?? null;
    }
    isRetired(threadId, accountId) {
        try {
            const index = this.readIndex();
            const operationId = index.activeByProjection[projectionKey(threadId, accountId)];
            if (!operationId || index.latestOutgoingByProjection[projectionKey(threadId, accountId)] !== operationId)
                return false;
            const receipt = this.readReceipt(operationId);
            return receipt?.phase === "retired" && receipt.threadId === threadId && receipt.sourceAccountId === accountId;
        }
        catch {
            return false;
        }
    }
    localProjectionValues(threadId, accountId, columns) {
        try {
            const operationId = this.latestOutgoingOperation(threadId, accountId);
            if (!operationId)
                return { state: "none" };
            const receipt = this.readReceipt(operationId);
            const account = this.accounts().find((value) => value.accountId === accountId);
            if (!receipt || receipt.phase !== "retired" || receipt.threadId !== threadId || receipt.sourceAccountId !== accountId || !account
                || receipt.sourceHome !== account.codexHome || receipt.sourceSqliteHome !== account.sqliteHome
                || !sameIdentity(receipt.sourceHomeIdentity, directoryIdentity(account.codexHome))
                || !sameIdentity(receipt.sourceSqliteHomeIdentity, directoryIdentity(account.sqliteHome))
                || !sameIdentity(receipt.stateIdentity, regularIdentity((0, node_path_1.join)(account.sqliteHome, "state_5.sqlite"))))
                return { state: "held" };
            this.verifyCopies(receipt);
            const values = {};
            for (const column of columns)
                if (Object.hasOwn(receipt.rows.row, column)) {
                    const value = receipt.rows.row[column];
                    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
                        return { state: "held" };
                    values[column] = value;
                }
            return { state: "ready", values };
        }
        catch {
            return { state: "held" };
        }
    }
    async retire(context) {
        try {
            if (!this.db.readRetirementRows || !this.db.compareAndDeleteRetirementRows
                || !context.mutationGuard())
                return { state: "held" };
            this.assertContext(context);
            const index = this.readIndex();
            if (index.latestOutgoingByProjection[projectionKey(context.threadId, context.source.accountId)] !== context.operationId)
                return { state: "held" };
            let receipt = this.readReceipt(context.operationId);
            if (receipt?.phase === "retired") {
                this.assertReceiptContext(context, receipt);
                index.activeByProjection[projectionKey(context.threadId, context.source.accountId)] = context.operationId;
                this.writeIndex(index); // Finish a crash between the receipt and index commits.
                return { state: await this.verify(context) && context.mutationGuard() ? "retired" : "held" };
            }
            if (!await context.targetStillPrepared())
                return { state: "held" };
            if (!receipt) {
                const files = this.scanSourceFiles(context);
                if (!files.length || !this.filesMatchPrepared(context, files))
                    return { state: "held" };
                const streamIds = [...new Set(files.map((file) => file.streamId))].sort();
                const rows = await this.db.readRetirementRows(statePath(context), historyPath(context), context.threadId, streamIds);
                if (!rows.row || !this.rowsMatchPrepared(context, rows) || !context.mutationGuard()
                    || !await context.targetStillPrepared() || stable(files) !== stable(this.scanSourceFiles(context)))
                    return { state: "held" };
                receipt = {
                    version: 2, operationId: context.operationId, threadId: context.threadId,
                    sourceAccountId: context.source.accountId, targetAccountId: context.target.accountId,
                    generationDigest: context.generationDigest,
                    sourceHome: context.source.codexHome, sourceSqliteHome: context.source.sqliteHome,
                    sourceHomeIdentity: directoryIdentity(context.source.codexHome),
                    sourceSqliteHomeIdentity: directoryIdentity(context.source.sqliteHome),
                    stateIdentity: regularIdentity(statePath(context)), historyIdentity: regularIdentity(historyPath(context)),
                    phase: "snapshotting", rows, files,
                };
                this.writeReceipt(receipt);
            }
            this.assertReceiptContext(context, receipt);
            if (!context.mutationGuard() || !await context.targetStillPrepared())
                return { state: "held" };
            const streamIds = [...new Set(receipt.files.map((file) => file.streamId))].sort();
            if (receipt.phase === "snapshotting") {
                if (stable(this.scanSourceFiles(context)) !== stable(receipt.files)
                    || stable(await this.db.readRetirementRows(statePath(context), historyPath(context), context.threadId, streamIds)) !== stable(receipt.rows))
                    return { state: "held" };
                for (let index = 0; index < receipt.files.length; index += 1) {
                    if (!context.mutationGuard())
                        return { state: "held" };
                    const file = receipt.files[index];
                    const source = this.sourceFile(context, file);
                    const copy = this.retainedPath(receipt.operationId, "snapshots", index, true);
                    if (!(0, node_fs_1.existsSync)(copy))
                        this.publishIndependentCopy(source, copy, file);
                    this.assertIndependentCopy(copy, file);
                    syncFile(copy);
                    syncDirectory((0, node_path_1.dirname)(copy));
                    assertFile(source, file);
                }
                if (!context.mutationGuard() || !await context.targetStillPrepared()
                    || stable(this.scanSourceFiles(context)) !== stable(receipt.files))
                    return { state: "held" };
                receipt.phase = "moving";
                this.writeReceipt(receipt); // Intent precedes every native-home rename.
            }
            this.verifyCopies(receipt);
            if (receipt.phase === "moving") {
                const remaining = this.scanSourceFiles(context);
                if (remaining.some((file) => !receipt.files.some((saved) => stable(saved) === stable(file))))
                    return { state: "held" };
                if (stable(await this.db.readRetirementRows(statePath(context), historyPath(context), context.threadId, streamIds)) !== stable(receipt.rows))
                    return { state: "held" };
                for (let index = 0; index < receipt.files.length; index += 1) {
                    if (!context.mutationGuard() || !await context.targetStillPrepared())
                        return { state: "held" };
                    const file = receipt.files[index];
                    const source = this.sourceFile(context, file);
                    const moved = this.retainedPath(receipt.operationId, "removed-links", index, true);
                    if ((0, node_fs_1.existsSync)(source)) {
                        if ((0, node_fs_1.existsSync)(moved))
                            return { state: "held" };
                        assertFile(source, file);
                        (0, node_fs_1.renameSync)(source, moved);
                        syncDirectory((0, node_path_1.dirname)(source));
                        syncDirectory((0, node_path_1.dirname)(moved));
                    }
                    assertFile(moved, file);
                    if ((0, node_fs_1.existsSync)(source))
                        return { state: "held" };
                }
                if (!context.mutationGuard() || !await context.targetStillPrepared() || this.scanSourceFiles(context).length)
                    return { state: "held" };
                receipt.phase = "deleting_rows";
                this.writeReceipt(receipt); // Also makes an interrupted multi-DB commit recoverable.
            }
            if (receipt.phase === "deleting_rows") {
                if (!context.mutationGuard() || !await context.targetStillPrepared() || this.scanSourceFiles(context).length)
                    return { state: "held" };
                for (let index = 0; index < receipt.files.length; index += 1)
                    assertFile(this.retainedPath(receipt.operationId, "removed-links", index), receipt.files[index]);
                await this.db.compareAndDeleteRetirementRows(statePath(context), historyPath(context), context.threadId, streamIds, receipt.rows);
                if (!context.mutationGuard() || !await context.targetStillPrepared() || !await this.absent(context, receipt))
                    return { state: "held" };
                receipt.phase = "retired";
                this.writeReceipt(receipt);
            }
            const current = this.readIndex();
            if (current.latestOutgoingByProjection[projectionKey(context.threadId, context.source.accountId)] !== context.operationId)
                return { state: "held" };
            current.activeByProjection[projectionKey(context.threadId, context.source.accountId)] = context.operationId;
            this.writeIndex(current);
            return { state: await this.verify(context) && context.mutationGuard() ? "retired" : "held" };
        }
        catch {
            return { state: "held" };
        }
    }
    async verify(context) {
        try {
            if (!context.observationGuard())
                return false;
            this.assertContext(context);
            const before = this.readIndex();
            if (before.activeByProjection[projectionKey(context.threadId, context.source.accountId)] !== context.operationId
                || before.latestOutgoingByProjection[projectionKey(context.threadId, context.source.accountId)] !== context.operationId)
                return false;
            const receipt = this.readReceipt(context.operationId);
            if (!receipt || receipt.phase !== "retired")
                return false;
            this.assertReceiptContext(context, receipt);
            this.verifyCopies(receipt);
            return await this.absent(context, receipt) && context.observationGuard() && stable(before) === stable(this.readIndex());
        }
        catch {
            return false;
        }
    }
    async absent(context, receipt) {
        if (!this.db.readRetirementRows || this.scanSourceFiles(context).length)
            return false;
        const ids = [...new Set(receipt.files.map((file) => file.streamId))].sort();
        const rows = await this.db.readRetirementRows(statePath(context), historyPath(context), context.threadId, ids);
        return rows.row === null && rows.stateSchema === receipt.rows.stateSchema && rows.history.schema === receipt.rows.history.schema
            && Object.values(rows.history.rows).every((values) => values.length === 0) && this.scanSourceFiles(context).length === 0;
    }
    rowsMatchPrepared(context, rows) {
        return Boolean(rows.row && Object.entries(context.expectedRow).every(([key, value]) => rows.row[key] === value)
            && stable(rows.history) === stable(context.expectedHistory));
    }
    filesMatchPrepared(context, files) {
        return context.expectedStreams.every((stream) => files.some((file) => (0, node_path_1.join)(context.source.codexHome, file.relativePath) === stream.path
            && sameIdentity(file.identity, stream.identity) && file.size === stream.size && file.digest === stream.digest))
            && files.every((file) => context.expectedStreams.some((stream) => file.streamId === stream.streamId
                && file.size === stream.size && file.digest === stream.digest));
    }
    scanSourceFiles(context) {
        const files = [];
        const knownIds = new Set([context.threadId, ...context.expectedStreams.map((stream) => stream.streamId)]);
        let entriesSeen = 0;
        let totalBytes = 0;
        const visit = (directory, depth) => {
            directoryIdentity(directory, false);
            const entries = (0, node_fs_1.readdirSync)(directory, { withFileTypes: true });
            entriesSeen += entries.length;
            if (entriesSeen > 65536 || depth > 4)
                throw new Error("retirement stream scan exceeded bounds");
            for (const entry of entries) {
                const path = (0, node_path_1.join)(directory, entry.name);
                if (entry.isSymbolicLink())
                    throw new Error("retirement cannot prove a linked stream namespace absent");
                if (entry.isDirectory()) {
                    visit(path, depth + 1);
                    continue;
                }
                if (![...knownIds].some((id) => entry.name.includes(id)))
                    continue;
                const suffix = /(?:^|-)([a-f0-9-]{36})(?:_([a-f0-9-]{36}))?\.jsonl$/.exec(entry.name);
                if (!suffix || !THREAD_ID.test(suffix[1]) || suffix[2] && !THREAD_ID.test(suffix[2]))
                    throw new Error("unknown selected stream layout");
                const streamId = suffix[2] ?? suffix[1];
                const observed = inspectFile(path);
                totalBytes += observed.size;
                if (files.length >= MAX_STREAMS || totalBytes > MAX_TOTAL_BYTES)
                    throw new Error("retirement stream snapshot exceeded bounds");
                files.push({ relativePath: (0, node_path_1.relative)(context.source.codexHome, path), streamId, ...observed });
            }
        };
        for (const name of ["sessions", "archived_sessions"]) {
            const path = (0, node_path_1.join)(context.source.codexHome, name);
            if ((0, node_fs_1.existsSync)(path))
                visit(path, 0);
        }
        return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    }
    sourceFile(context, file) {
        if (!safeRelativePath(file.relativePath))
            throw new Error("retirement source path escaped its native home");
        const path = (0, node_path_1.join)(context.source.codexHome, file.relativePath);
        let cursor = (0, node_path_1.dirname)(path);
        while (cursor !== context.source.codexHome) {
            directoryIdentity(cursor, false);
            cursor = (0, node_path_1.dirname)(cursor);
        }
        return path;
    }
    assertIndependentCopy(path, file) {
        (0, state_store_1.assertPrivateRegularFile)(path, MAX_STREAM_BYTES);
        const copy = inspectFile(path);
        if (sameIdentity(copy.identity, file.identity) || copy.digest !== file.digest || copy.size !== file.size)
            throw new Error("retirement snapshot is not an independent exact copy");
    }
    publishIndependentCopy(source, destination, file) {
        const root = (0, node_path_1.dirname)(destination);
        const prefix = "." + destination.slice(root.length + 1) + ".partial-";
        const retained = (0, node_fs_1.readdirSync)(root).filter((name) => name.startsWith(prefix));
        let staged = null;
        for (const name of retained) {
            const candidate = (0, node_path_1.join)(root, name);
            (0, state_store_1.assertPrivateRegularFile)(candidate, MAX_STREAM_BYTES);
            try {
                this.assertIndependentCopy(candidate, file);
                staged = candidate;
                break;
            }
            catch { /* Preserve an incomplete private copy; it never occupies the final name. */ }
        }
        if (!staged) {
            if (retained.length >= 4)
                throw new Error("retirement partial-copy bound exceeded");
            staged = (0, node_path_1.join)(root, prefix + (0, node_crypto_1.randomUUID)());
            // Create the partial with private permissions before any bytes appear.
            const descriptor = (0, node_fs_1.openSync)(staged, node_fs_1.constants.O_WRONLY | node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_NOFOLLOW, 0o600);
            (0, node_fs_1.closeSync)(descriptor);
            assertFile(source, file);
            try {
                (0, node_fs_1.copyFileSync)(source, staged);
            }
            finally {
                if ((0, node_fs_1.existsSync)(staged)) {
                    regularIdentity(staged);
                    (0, node_fs_1.chmodSync)(staged, 0o600);
                }
            }
        }
        this.assertIndependentCopy(staged, file);
        assertFile(source, file);
        syncFile(staged);
        (0, node_fs_1.linkSync)(staged, destination); // Atomic and cannot overwrite a concurrent final copy.
        syncDirectory(root);
        if (!sameIdentity(regularIdentity(staged), regularIdentity(destination)))
            throw new Error("retirement snapshot publication changed");
        (0, node_fs_1.unlinkSync)(staged);
        syncDirectory(root);
    }
    verifyCopies(receipt) {
        for (let index = 0; index < receipt.files.length; index += 1)
            this.assertIndependentCopy(this.retainedPath(receipt.operationId, "snapshots", index), receipt.files[index]);
    }
    assertContext(context) {
        this.root(false);
        if (!validOperationId(context.operationId) || !THREAD_ID.test(context.threadId) || !DIGEST.test(context.generationDigest)
            || !(0, types_1.isOpaqueAccountId)(context.source.accountId) || !(0, types_1.isOpaqueAccountId)(context.target.accountId)
            || context.source.accountId === context.target.accountId)
            throw new Error("retirement context invalid");
        for (const account of [context.source, context.target]) {
            directoryIdentity(account.codexHome);
            directoryIdentity(account.sqliteHome);
        }
    }
    assertReceiptContext(context, receipt) {
        if (receipt.operationId !== context.operationId || receipt.threadId !== context.threadId
            || receipt.sourceAccountId !== context.source.accountId || receipt.targetAccountId !== context.target.accountId
            || receipt.sourceHome !== context.source.codexHome || receipt.sourceSqliteHome !== context.source.sqliteHome
            || receipt.generationDigest !== context.generationDigest || !this.rowsMatchPrepared(context, receipt.rows)
            || !this.filesMatchPrepared(context, receipt.files)
            || !sameIdentity(receipt.sourceHomeIdentity, directoryIdentity(context.source.codexHome))
            || !sameIdentity(receipt.sourceSqliteHomeIdentity, directoryIdentity(context.source.sqliteHome))
            || !sameIdentity(receipt.stateIdentity, regularIdentity(statePath(context)))
            || !sameIdentity(receipt.historyIdentity, regularIdentity(historyPath(context))))
            throw new Error("retirement provenance changed");
    }
    root(create) {
        directoryIdentity(this.stateRoot);
        const root = (0, node_path_1.join)(this.stateRoot, DIRECTORY);
        for (const account of this.accounts())
            for (const home of [account.codexHome, account.sqliteHome]) {
                if (inside(home, root) || inside(root, home))
                    throw new Error("retirement storage overlaps a native home");
            }
        if (create && !(0, node_fs_1.existsSync)(root))
            (0, node_fs_1.mkdirSync)(root, { mode: 0o700 });
        if ((0, node_fs_1.existsSync)(root))
            directoryIdentity(root);
        return root;
    }
    operationRoot(operationId, create) {
        if (!validOperationId(operationId))
            throw new Error("retirement operation id invalid");
        const root = (0, node_path_1.join)(this.root(create), (0, node_crypto_1.createHash)("sha256").update(operationId).digest("hex"));
        if (create && !(0, node_fs_1.existsSync)(root))
            (0, node_fs_1.mkdirSync)(root, { mode: 0o700 });
        if ((0, node_fs_1.existsSync)(root))
            directoryIdentity(root);
        return root;
    }
    retainedPath(operationId, kind, index, create = false) {
        const root = (0, node_path_1.join)(this.operationRoot(operationId, create), kind);
        if (create && !(0, node_fs_1.existsSync)(root))
            (0, node_fs_1.mkdirSync)(root, { mode: 0o700 });
        directoryIdentity(root);
        return (0, node_path_1.join)(root, String(index).padStart(4, "0") + ".jsonl");
    }
    readReceipt(operationId) {
        const path = (0, node_path_1.join)(this.operationRoot(operationId, false), "receipt.json");
        if (!(0, node_fs_1.existsSync)(path))
            return null;
        (0, state_store_1.assertPrivateRegularFile)(path, MAX_RECEIPT_BYTES);
        const wrapper = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
        if (!(0, types_1.isPlainRecord)(wrapper) || !(0, types_1.isPlainRecord)(wrapper.receipt) || wrapper.digest !== digest(wrapper.receipt))
            throw new Error("retirement receipt digest invalid");
        const value = wrapper.receipt;
        if (value.version !== 2 || value.operationId !== operationId || typeof value.threadId !== "string" || !THREAD_ID.test(value.threadId)
            || !(0, types_1.isOpaqueAccountId)(value.sourceAccountId) || !(0, types_1.isOpaqueAccountId)(value.targetAccountId)
            || typeof value.generationDigest !== "string" || !DIGEST.test(value.generationDigest)
            || typeof value.sourceHome !== "string" || typeof value.sourceSqliteHome !== "string"
            || !["snapshotting", "moving", "deleting_rows", "retired"].includes(String(value.phase))
            || !(0, types_1.isPlainRecord)(value.rows) || !(0, types_1.isPlainRecord)(value.rows.row) || !(0, types_1.isPlainRecord)(value.rows.history)
            || typeof value.rows.stateSchema !== "string" || !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_STREAMS
            || ![value.sourceHomeIdentity, value.sourceSqliteHomeIdentity, value.stateIdentity, value.historyIdentity].every(validIdentity)
            || !value.files.every((file) => (0, types_1.isPlainRecord)(file) && typeof file.relativePath === "string" && safeRelativePath(file.relativePath)
                && typeof file.streamId === "string" && THREAD_ID.test(file.streamId) && validIdentity(file.identity)
                && typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_STREAM_BYTES
                && typeof file.digest === "string" && DIGEST.test(file.digest)))
            throw new Error("retirement receipt invalid");
        return value;
    }
    writeReceipt(receipt) {
        (0, state_store_1.writePrivateJsonAtomicBounded)(this.operationRoot(receipt.operationId, true), "receipt.json", { digest: digest(receipt), receipt }, MAX_RECEIPT_BYTES);
    }
    readIndex() {
        const path = (0, node_path_1.join)(this.root(false), "index.json");
        if (!(0, node_fs_1.existsSync)(path))
            return { version: 2, latestByThread: {}, latestOutgoingByProjection: {}, activeByProjection: {} };
        (0, state_store_1.assertPrivateRegularFile)(path, MAX_INDEX_BYTES);
        const value = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
        if (!(0, types_1.isPlainRecord)(value) || value.version !== 2 || !(0, types_1.isPlainRecord)(value.latestByThread) || !(0, types_1.isPlainRecord)(value.latestOutgoingByProjection) || !(0, types_1.isPlainRecord)(value.activeByProjection)
            || Object.entries(value.latestByThread).some(([key, operation]) => !THREAD_ID.test(key) || !validOperationId(operation))
            || Object.entries(value.latestOutgoingByProjection).some(([key, operation]) => !validProjectionKey(key) || !validOperationId(operation))
            || Object.entries(value.activeByProjection).some(([key, operation]) => !validProjectionKey(key) || operation !== null && !validOperationId(operation)))
            throw new Error("retirement index invalid");
        return value;
    }
    writeIndex(index) {
        (0, state_store_1.writePrivateJsonAtomicBounded)(this.root(true), "index.json", index, MAX_INDEX_BYTES);
    }
}
exports.NativeSourceRetirementStoreV2 = NativeSourceRetirementStoreV2;
function statePath(context) { return (0, node_path_1.join)(context.source.sqliteHome, "state_5.sqlite"); }
function historyPath(context) { return (0, node_path_1.join)(context.source.sqliteHome, "thread_history_1.sqlite"); }
function projectionKey(threadId, accountId) { return accountId + ":" + threadId; }
function validProjectionKey(value) { const parts = value.split(":"); return parts.length === 2 && (0, types_1.isOpaqueAccountId)(parts[0]) && THREAD_ID.test(parts[1]); }
function validOperationId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function inside(parent, path) { const suffix = (0, node_path_1.relative)(parent, path); return suffix === "" || !suffix.startsWith("..") && !(0, node_path_1.isAbsolute)(suffix); }
function safeRelativePath(path) {
    const parts = path.split("/");
    return parts.length >= 2 && parts.length <= 6 && ["sessions", "archived_sessions"].includes(parts[0])
        && parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0"));
}
function validIdentity(value) {
    return (0, types_1.isPlainRecord)(value) && typeof value.dev === "number" && Number.isSafeInteger(value.dev) && value.dev >= 0
        && typeof value.ino === "number" && Number.isSafeInteger(value.ino) && value.ino >= 0;
}
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function directoryIdentity(path, privateMode = true) {
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!(0, node_path_1.isAbsolute)(path) || (0, node_fs_1.realpathSync)(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()
        || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || privateMode && (stat.mode & 0o777) !== 0o700)
        throw new Error("retirement directory is unsafe");
    return { dev: stat.dev, ino: stat.ino };
}
function regularIdentity(path) {
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
        throw new Error("retirement file is unsafe");
    return { dev: stat.dev, ino: stat.ino };
}
function inspectFile(path) {
    const identity = regularIdentity(path);
    const fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
    try {
        const before = (0, node_fs_1.fstatSync)(fd);
        if (!sameIdentity(identity, before) || !before.isFile() || before.size > MAX_STREAM_BYTES)
            throw new Error("retirement stream changed");
        const bytes = (0, node_fs_1.readFileSync)(fd);
        const after = (0, node_fs_1.fstatSync)(fd);
        if (!sameIdentity(identity, after) || before.size !== after.size || bytes.byteLength !== before.size
            || !sameIdentity(identity, regularIdentity(path)))
            throw new Error("retirement stream changed");
        return { identity, size: before.size, digest: "sha256:" + (0, node_crypto_1.createHash)("sha256").update(bytes).digest("hex") };
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
}
function assertFile(path, expected) {
    const observed = inspectFile(path);
    if (!sameIdentity(observed.identity, expected.identity) || observed.size !== expected.size || observed.digest !== expected.digest)
        throw new Error("retirement stream provenance changed");
}
function syncFile(path) {
    const descriptor = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
    try {
        (0, node_fs_1.fsyncSync)(descriptor);
    }
    finally {
        (0, node_fs_1.closeSync)(descriptor);
    }
}
function syncDirectory(path) {
    try {
        syncFile(path);
    }
    catch (error) {
        // Match the private journal writer's portable directory-fsync behavior.
        if (!["EINVAL", "ENOTSUP"].includes(String(error.code)))
            throw error;
    }
}
function stable(value) {
    return JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
        ? Object.fromEntries(Object.entries(child).sort(([left], [right]) => left.localeCompare(right))) : child);
}
function digest(value) { return "sha256:" + (0, node_crypto_1.createHash)("sha256").update(stable(value)).digest("hex"); }
//# sourceMappingURL=native-source-retirement.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RouterStateStore = void 0;
exports.createInitialRouterState = createInitialRouterState;
exports.validateRouterState = validateRouterState;
exports.ensurePrivateDirectory = ensurePrivateDirectory;
exports.assertPrivateRegularFile = assertPrivateRegularFile;
exports.writePrivateJsonAtomic = writePrivateJsonAtomic;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const types_1 = require("./types");
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
function createInitialRouterState(config) {
    const ledger = {};
    const accountEligibility = {};
    for (const account of config.accounts) {
        ledger[account.opaqueAccountId] = {
            completedInputTokens: 0,
            completedOutputTokens: 0,
            reservedRequestCost: 0,
            weight: account.weight,
            assignedThreadCount: 0,
        };
        accountEligibility[account.opaqueAccountId] = account.included ? "validating" : "disabled";
    }
    return {
        schemaVersion: types_1.ACCOUNT_ROUTER_SCHEMA_VERSION,
        protocolFingerprint: types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
        epoch: 1,
        threadOwners: {},
        pendingThreadOwners: {},
        ledger,
        reservations: [],
        accountEligibility,
        correlations: [],
        stagedDisable: null,
    };
}
/** Durable owner/ledger state with strict shape checking and private atomic writes. */
class RouterStateStore {
    root;
    config;
    fileName;
    state;
    constructor(root, config, fileName = "router-state.json") {
        this.root = root;
        this.config = config;
        this.fileName = fileName;
        ensurePrivateDirectory(root);
        this.state = this.load();
    }
    get path() {
        return (0, node_path_1.join)(this.root, this.fileName);
    }
    snapshot() {
        return structuredClone(this.state);
    }
    update(mutator) {
        const next = structuredClone(this.state);
        mutator(next);
        if (!validateRouterState(next, this.config))
            throw new Error("account-router refused an invalid durable state");
        writePrivateJsonAtomic(this.root, this.fileName, next);
        this.state = next;
        return this.snapshot();
    }
    load() {
        if (!(0, node_fs_1.existsSync)(this.path)) {
            const initial = createInitialRouterState(this.config);
            writePrivateJsonAtomic(this.root, this.fileName, initial);
            return initial;
        }
        assertPrivateRegularFile(this.path, MAX_STATE_BYTES);
        const raw = (0, node_fs_1.readFileSync)(this.path, "utf8");
        if (Buffer.byteLength(raw) > MAX_STATE_BYTES)
            throw new Error("account-router state exceeds its bounded size");
        const parsed = JSON.parse(raw);
        if (!validateRouterState(parsed, this.config))
            throw new Error("account-router state failed strict validation");
        return parsed;
    }
}
exports.RouterStateStore = RouterStateStore;
function validateRouterState(value, config) {
    if (!(0, types_1.isPlainRecord)(value))
        return false;
    const allowed = new Set([
        "schemaVersion", "protocolFingerprint", "epoch", "threadOwners", "pendingThreadOwners", "ledger",
        "reservations", "accountEligibility", "correlations", "stagedDisable",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
        return false;
    const epoch = value.epoch;
    if (value.schemaVersion !== types_1.ACCOUNT_ROUTER_SCHEMA_VERSION
        || value.protocolFingerprint !== types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
        || typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 1
        || !(0, types_1.isPlainRecord)(value.threadOwners) || !(0, types_1.isPlainRecord)(value.pendingThreadOwners)
        || !(0, types_1.isPlainRecord)(value.ledger) || !(0, types_1.isPlainRecord)(value.accountEligibility)
        || !Array.isArray(value.reservations) || !Array.isArray(value.correlations))
        return false;
    const configured = new Set(config.accounts.map((account) => account.opaqueAccountId));
    if (!allOwnerValuesConfigured(value.threadOwners, configured) || !allOwnerValuesConfigured(value.pendingThreadOwners, configured))
        return false;
    if (!validateLedger(value.ledger, config) || !validateEligibility(value.accountEligibility, configured))
        return false;
    if (!value.reservations.every((reservation) => validateReservation(reservation, configured, epoch)))
        return false;
    if (!value.correlations.every((correlation) => validateCorrelation(correlation, configured)))
        return false;
    return value.stagedDisable === null || validateStagedDisable(value.stagedDisable);
}
function allOwnerValuesConfigured(value, configured) {
    return Object.entries(value).every(([threadId, owner]) => threadId.length > 0 && (0, types_1.isOpaqueAccountId)(owner) && configured.has(owner));
}
function validateLedger(value, config) {
    const configured = new Map(config.accounts.map((account) => [account.opaqueAccountId, account]));
    if (Object.keys(value).length !== configured.size)
        return false;
    return Object.entries(value).every(([opaqueId, entry]) => {
        if (!(0, types_1.isPlainRecord)(entry))
            return false;
        if (!(0, types_1.isOpaqueAccountId)(opaqueId))
            return false;
        const account = configured.get(opaqueId);
        if (!account)
            return false;
        const allowed = new Set(["completedInputTokens", "completedOutputTokens", "reservedRequestCost", "weight", "assignedThreadCount"]);
        return Object.keys(entry).every((key) => allowed.has(key))
            && entry.weight === account.weight
            && [entry.completedInputTokens, entry.completedOutputTokens, entry.reservedRequestCost, entry.assignedThreadCount]
                .every((number) => Number.isInteger(number) && typeof number === "number" && number >= 0);
    });
}
function validateEligibility(value, configured) {
    return Object.entries(value).every(([opaqueId, state]) => configured.has(opaqueId) && typeof state === "string" && types_1.ELIGIBILITY_STATES.has(state));
}
function validateReservation(value, configured, epoch) {
    if (!(0, types_1.isPlainRecord)(value))
        return false;
    const allowed = new Set(["reservationId", "opaqueAccountId", "estimatedCost", "state", "epoch"]);
    return Object.keys(value).every((key) => allowed.has(key))
        && typeof value.reservationId === "string" && /^rs_[A-Za-z0-9_-]{16,64}$/.test(value.reservationId)
        && (0, types_1.isOpaqueAccountId)(value.opaqueAccountId) && configured.has(value.opaqueAccountId)
        && typeof value.estimatedCost === "number" && Number.isInteger(value.estimatedCost)
        && value.estimatedCost >= 1 && value.estimatedCost <= 32_768
        && (value.state === "reserved" || value.state === "released_pre_dispatch" || value.state === "stranded_ambiguous" || value.state === "reconciled")
        && typeof value.epoch === "number" && Number.isInteger(value.epoch) && value.epoch >= 1 && value.epoch <= epoch;
}
function validateCorrelation(value, configured) {
    if (!(0, types_1.isPlainRecord)(value))
        return false;
    const allowed = new Set(["schemaVersion", "direction", "childOpaqueAccountId", "muxNonce", "originalId", "method", "dispatchState"]);
    return Object.keys(value).every((key) => allowed.has(key))
        && value.schemaVersion === types_1.ACCOUNT_ROUTER_SCHEMA_VERSION
        && (value.direction === "client_to_child" || value.direction === "child_to_client")
        && (0, types_1.isOpaqueAccountId)(value.childOpaqueAccountId) && configured.has(value.childOpaqueAccountId)
        && typeof value.muxNonce === "string" && /^[1-9][0-9]{0,19}$/.test(value.muxNonce)
        && (0, types_1.isJsonRpcId)(value.originalId)
        && typeof value.method === "string" && value.method.length > 0 && value.method.length <= 256
        && (value.dispatchState === "prepared" || value.dispatchState === "written" || value.dispatchState === "acknowledged" || value.dispatchState === "terminal");
}
function validateStagedDisable(value) {
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).some((key) => key !== "reasonCode" && key !== "stagedAt"))
        return false;
    return (value.reasonCode === "post_start_failure" || value.reasonCode === "protocol_drift" || value.reasonCode === "isolation_failure" || value.reasonCode === "policy_stop" || value.reasonCode === "operator_disable")
        && typeof value.stagedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?:\.\d+)?Z$/.test(value.stagedAt);
}
function ensurePrivateDirectory(path) {
    const resolved = (0, node_path_1.resolve)(path);
    if ((0, node_fs_1.existsSync)(resolved)) {
        const stat = (0, node_fs_1.lstatSync)(resolved);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error("account-router refused an unsafe state directory");
    }
    else {
        (0, node_fs_1.mkdirSync)(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    }
    const stat = (0, node_fs_1.statSync)(resolved);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new Error("account-router state directory is not owner-private");
    }
    (0, node_fs_1.chmodSync)(resolved, PRIVATE_DIRECTORY_MODE);
}
function assertPrivateRegularFile(path, maxBytes) {
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > maxBytes || (stat.mode & 0o077) !== 0) {
        throw new Error("account-router refused an unsafe private file");
    }
}
function writePrivateJsonAtomic(root, fileName, value) {
    ensurePrivateDirectory(root);
    if ((0, node_path_1.basename)(fileName) !== fileName || fileName.includes(".."))
        throw new Error("unsafe account-router file name");
    const target = (0, node_path_1.join)(root, fileName);
    if ((0, node_path_1.dirname)(target) !== (0, node_path_1.resolve)(root))
        throw new Error("account-router path escaped its state root");
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.byteLength > MAX_STATE_BYTES)
        throw new Error("account-router refused an oversized state write");
    const temporary = (0, node_path_1.join)(root, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
    let descriptor;
    try {
        descriptor = (0, node_fs_1.openSync)(temporary, node_fs_1.constants.O_WRONLY | node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
        (0, node_fs_1.writeFileSync)(descriptor, bytes);
        (0, node_fs_1.fsyncSync)(descriptor);
        (0, node_fs_1.closeSync)(descriptor);
        descriptor = undefined;
        (0, node_fs_1.chmodSync)(temporary, PRIVATE_FILE_MODE);
        assertPrivateRegularFile(temporary, MAX_STATE_BYTES);
        if ((0, node_fs_1.existsSync)(target))
            assertPrivateRegularFile(target, MAX_STATE_BYTES);
        (0, node_fs_1.renameSync)(temporary, target);
        (0, node_fs_1.chmodSync)(target, PRIVATE_FILE_MODE);
        assertPrivateRegularFile(target, MAX_STATE_BYTES);
        fsyncDirectory(root);
    }
    finally {
        if (descriptor !== undefined)
            (0, node_fs_1.closeSync)(descriptor);
        if ((0, node_fs_1.existsSync)(temporary)) {
            try {
                (0, node_fs_1.unlinkSync)(temporary);
            }
            catch { /* exact private temporary only */ }
        }
    }
}
function fsyncDirectory(directory) {
    let descriptor;
    try {
        descriptor = (0, node_fs_1.openSync)(directory, node_fs_1.constants.O_RDONLY);
        (0, node_fs_1.fsyncSync)(descriptor);
    }
    catch {
        // APFS can decline directory fsync. The file fsync + rename remains the
        // conservative portable guarantee; never widen the target on failure.
    }
    finally {
        if (descriptor !== undefined)
            (0, node_fs_1.closeSync)(descriptor);
    }
}
//# sourceMappingURL=state-store.js.map
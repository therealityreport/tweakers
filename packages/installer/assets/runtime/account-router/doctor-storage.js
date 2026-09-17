"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inspectNativeStorageIdentitiesAtRoot = inspectNativeStorageIdentitiesAtRoot;
exports.repairNativeStorageIdentitiesAtRoot = repairNativeStorageIdentitiesAtRoot;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("./config");
const broker_socket_1 = require("./broker-socket");
const native_history_1 = require("./native-history");
const shared_native_mode_1 = require("./shared-native-mode");
const state_store_1 = require("./state-store");
const native_auth_binding_1 = require("./native-auth-binding");
const persistent_directory_identity_1 = require("./persistent-directory-identity");
const hash = (value) => `sha256:${(0, node_crypto_1.createHash)("sha256").update(JSON.stringify(value)).digest("hex")}`;
function pendingRecovery(root) {
    if (["enrollment-materialization.v1.json", "shared-native-mode-transition.v1.json", "shared-native-resolver-transition.v1.json",
        "shared-account-config/shared-source-rebase-intent.v1.json"].some(name => (0, node_fs_1.existsSync)((0, node_path_1.join)(root, name))))
        return true;
    const accounts = (0, node_path_1.join)(root, "accounts");
    if (!(0, node_fs_1.existsSync)(accounts))
        return false;
    if (!(0, node_fs_1.lstatSync)(accounts).isDirectory() || (0, node_fs_1.lstatSync)(accounts).isSymbolicLink())
        return true;
    return (0, node_fs_1.readdirSync)(accounts).some(name => ["config-materialization-intent.v1.json", "plugin-projection-intent.v1.json", "native-initial-capture-intent.v1.json"]
        .some(file => (0, node_fs_1.existsSync)((0, node_path_1.join)(accounts, name, file))));
}
function inspectWithSecret(root, secret) {
    const files = ["account-router-config.json", "native-history-source.v1.json", "native-auth-binding.v1.json", "shared-native-mode.v1.json", "native-history-extensions.v1.json", persistent_directory_identity_1.PERSISTENT_IDENTITIES_FILE, persistent_directory_identity_1.PERSISTENT_IDENTITIES_JOURNAL];
    const input = files.map(name => ({ name, fingerprint: (0, node_fs_1.existsSync)((0, node_path_1.join)(root, name)) ? hash((0, native_auth_binding_1.readNativeAuthPrivateFileV1)((0, node_path_1.join)(root, name)).toString("base64")) : null }));
    const base = { fingerprint: hash(input), legacyVolumeUnproven: false };
    const config = (0, config_1.readRouterLaunchSelection)((0, node_path_1.join)(root, "account-router-config.json")).config;
    if (!config || config.schemaVersion !== 3)
        return { report: { ...base, state: "blocked", reason: "invalid_config" } };
    if (!(0, node_fs_1.existsSync)((0, node_path_1.join)(root, "native-history-source.v1.json")))
        return { report: { ...base, state: "not_applicable", reason: "legacy_storage" } };
    if (pendingRecovery(root))
        return { report: { ...base, state: "blocked", reason: "pending_metadata_recovery" } };
    const existing = (0, persistent_directory_identity_1.readPersistentIdentityGeneration)(root, secret);
    let failureReason = "storage_identity_invalid";
    const verify = () => {
        const native = (0, native_history_1.readAndPreflightNativeHistorySourceStaticV1)(root, config, secret);
        if (native.state !== "ready") {
            failureReason = native.state === "invalid" ? native.reason : "storage_identity_invalid";
            return false;
        }
        return (0, shared_native_mode_1.readSharedNativeModeV1)({ stateRoot: root, secret, binding: native.binding }).state !== "blocked";
    };
    let proposal;
    try {
        proposal = (0, persistent_directory_identity_1.preparePersistentIdentityGeneration)({ stateRoot: root, secret, verify, allowLegacyDeviceChange: true });
    }
    catch {
        return { report: { ...base, state: "blocked", reason: failureReason } };
    }
    const fingerprint = hash({ input, anchors: proposal.next.anchors });
    if ((0, node_fs_1.existsSync)((0, node_path_1.join)(root, persistent_directory_identity_1.PERSISTENT_IDENTITIES_JOURNAL))) {
        try {
            proposal = (0, persistent_directory_identity_1.validatePersistentIdentityProposal)(root, secret, JSON.parse((0, native_auth_binding_1.readNativeAuthPrivateFileV1)((0, node_path_1.join)(root, persistent_directory_identity_1.PERSISTENT_IDENTITIES_JOURNAL)).toString("utf8")));
        }
        catch {
            return { report: { fingerprint, state: "blocked", reason: "identity_repair_journal_invalid", legacyVolumeUnproven: false } };
        }
        return { report: { fingerprint, state: "repairable", reason: "identity_repair_incomplete", legacyVolumeUnproven: existing === null }, proposal };
    }
    if (existing && JSON.stringify(existing.document.anchors) === JSON.stringify(proposal.next.anchors) && verify())
        return { report: { fingerprint, state: "ready", reason: "persistent_identity_valid", legacyVolumeUnproven: false } };
    return { report: { fingerprint, state: "repairable", reason: verify() ? "legacy_identity_upgrade" : "device_number_changed", legacyVolumeUnproven: true }, proposal };
}
/** No mkdir, chmod, reservation, agent work, or credential/history writes. */
function inspectNativeStorageIdentitiesAtRoot(root) {
    let secret = null;
    try {
        secret = (0, broker_socket_1.readAccountsBrokerSecret)(root);
        if (!secret)
            return { state: "blocked", reason: "authentication_binding_unavailable", fingerprint: hash({ root, missing: true }), legacyVolumeUnproven: false };
        return inspectWithSecret(root, secret).report;
    }
    catch {
        return { state: "blocked", reason: "storage_metadata_invalid", fingerprint: hash({ root, invalid: true }), legacyVolumeUnproven: false };
    }
    finally {
        secret?.fill(0);
    }
}
/** Explicit metadata-only repair; an active broker retains its owner-election socket. */
async function repairNativeStorageIdentitiesAtRoot(root, expectedFingerprint) {
    const secret = (0, broker_socket_1.readAccountsBrokerSecret)(root);
    if (!secret)
        throw new Error("Authentication binding unavailable");
    let reservation;
    try {
        reservation = await (0, broker_socket_1.reserveAccountsBrokerSocket)({ root, secret });
        const inspected = inspectWithSecret(root, secret);
        if (inspected.report.fingerprint !== expectedFingerprint || inspected.report.state !== "repairable" || !inspected.proposal)
            throw new Error("Doctor storage repair evidence changed");
        const journalPath = (0, node_path_1.join)(root, persistent_directory_identity_1.PERSISTENT_IDENTITIES_JOURNAL);
        const proposal = inspected.proposal;
        if (!(0, node_fs_1.existsSync)(journalPath))
            (0, state_store_1.writePrivateJsonAtomicBounded)(root, persistent_directory_identity_1.PERSISTENT_IDENTITIES_JOURNAL, proposal, 256 * 1024);
        const fingerprints = ["native-history-source.v1.json", "native-auth-binding.v1.json", "shared-native-mode.v1.json", "native-history-extensions.v1.json"]
            .filter(name => (0, node_fs_1.existsSync)((0, node_path_1.join)(root, name))).map(name => [name, hash((0, node_fs_1.readFileSync)((0, node_path_1.join)(root, name)).toString("base64"))]);
        (0, persistent_directory_identity_1.publishPersistentIdentityGeneration)(root, secret, proposal);
        const config = (0, config_1.readRouterLaunchSelection)((0, node_path_1.join)(root, "account-router-config.json")).config;
        if (!config)
            throw new Error("Doctor repair config changed");
        const native = (0, native_history_1.readAndPreflightNativeHistorySourceStaticV1)(root, config, secret);
        if (native.state !== "ready" || (0, shared_native_mode_1.readSharedNativeModeV1)({ stateRoot: root, secret, binding: native.binding }).state === "blocked"
            || fingerprints.some(([name, fingerprint]) => fingerprint !== hash((0, node_fs_1.readFileSync)((0, node_path_1.join)(root, name)).toString("base64")))) {
            (0, persistent_directory_identity_1.restorePriorPersistentIdentityGeneration)(root, secret, proposal);
            throw new Error("Doctor repair postcondition failed; prior generation restored and recovery journal retained");
        }
        (0, node_fs_1.unlinkSync)(journalPath);
        const directory = (0, node_fs_1.openSync)(root, "r");
        try {
            (0, node_fs_1.fsyncSync)(directory);
        }
        finally {
            (0, node_fs_1.closeSync)(directory);
        }
        return inspectWithSecret(root, secret).report;
    }
    finally {
        await reservation?.close();
        secret.fill(0);
    }
}
//# sourceMappingURL=doctor-storage.js.map
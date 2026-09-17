"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inspectNativeAuthenticationAtRoot = inspectNativeAuthenticationAtRoot;
exports.reconnectNativeAuthenticationAtRoot = reconnectNativeAuthenticationAtRoot;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_child_process_1 = require("node:child_process");
const config_1 = require("./config");
const broker_socket_1 = require("./broker-socket");
const native_history_1 = require("./native-history");
const native_auth_binding_1 = require("./native-auth-binding");
const digest = (value) => `sha256:${(0, node_crypto_1.createHash)("sha256").update(JSON.stringify(value)).digest("hex")}`;
function authority(root, secret) {
    if (["native-storage-identities-repair.v2.json", "enrollment-materialization.v1.json", "shared-native-mode-transition.v1.json", "shared-native-resolver-transition.v1.json", "shared-account-config/shared-source-rebase-intent.v1.json"].some(name => (0, node_fs_1.existsSync)((0, node_path_1.join)(root, name))))
        throw new Error("Resolve pending account recovery first");
    const config = (0, config_1.readRouterLaunchSelection)((0, node_path_1.join)(root, "account-router-config.json")).config;
    if (!config || config.schemaVersion !== 3)
        throw new Error("Recovery authority unavailable");
    const source = (0, native_history_1.readNativeHistoryRecoveryAuthorityV1)(root, config, secret);
    const companion = (0, native_auth_binding_1.readNativeAuthBindingAuthorityV1)(root, source, secret);
    const accounts = source.accounts.map((entry, index) => {
        const home = companion?.document.accounts.find(a => a.opaqueAccountId === entry.opaqueAccountId)?.authHome ?? entry.codexHome;
        const bytes = (0, native_auth_binding_1.readNativeAuthPrivateFileV1)((0, node_path_1.join)(home, "auth.json"));
        let valid = false;
        try {
            (0, native_auth_binding_1.readNativeExternalTokensV1)(home, entry, secret);
            valid = true;
        }
        catch { /* Only this credential is repairable. */ }
        const fingerprint = digest(bytes.toString("base64"));
        bytes.fill(0);
        return { entry, home, valid, fingerprint, label: `Account ${index + 1}` };
    });
    const metadata = ["account-router-config.json", "native-history-source.v1.json", "native-auth-binding.v1.json", "native-storage-identities.v2.json"]
        .map(name => [name, (0, node_fs_1.existsSync)((0, node_path_1.join)(root, name)) ? digest((0, native_auth_binding_1.readNativeAuthPrivateFileV1)((0, node_path_1.join)(root, name)).toString("base64")) : null]);
    return { config, accounts, fingerprint: digest({ metadata, accounts: accounts.map(a => [a.entry.opaqueAccountId, a.home, a.fingerprint]) }) };
}
function inspectNativeAuthenticationAtRoot(root) {
    const secret = (0, broker_socket_1.readAccountsBrokerSecret)(root);
    try {
        if (!secret)
            throw new Error("unavailable");
        const value = authority(root, secret);
        const accounts = value.accounts.filter(a => !a.valid).map(a => ({ accountId: a.entry.opaqueAccountId, label: a.label }));
        return { state: accounts.length ? "reconnect_required" : "ready", fingerprint: value.fingerprint, accounts };
    }
    catch {
        return { state: "blocked", fingerprint: digest("unavailable"), accounts: [] };
    }
    finally {
        secret?.fill(0);
    }
}
/** No foreign process may hold the selected authentication home during publication. */
function assertIdle(home) {
    const result = (0, node_child_process_1.spawnSync)("/usr/sbin/lsof", ["-nP", "-t", "+D", home], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.signal || ![0, 1].includes(result.status ?? -1) || result.stderr.trim()
        || result.stdout.trim().split(/\s+/).filter(Boolean).some(pid => Number(pid) !== process.pid))
        throw new Error("Close the session using this account before reconnecting.");
}
/** The login callback must finish and reap its child before returning. */
async function reconnectNativeAuthenticationAtRoot(input) {
    const secret = (0, broker_socket_1.readAccountsBrokerSecret)(input.root);
    if (!secret)
        throw new Error("Recovery authority unavailable");
    let reservation;
    let stagedHome;
    let prior;
    try {
        try {
            reservation = await (0, broker_socket_1.reserveAccountsBrokerSocket)({ root: input.root, secret });
        }
        catch {
            const manager = new broker_socket_1.AccountsBrokerManagerClientV1({ root: input.root, secret });
            try {
                if (!await manager.prepareAuthenticationRecovery((0, node_crypto_1.randomUUID)()))
                    throw new Error("The broker is busy. Finish active account work before reconnecting.");
            }
            finally {
                await manager.close();
            }
            const deadline = Date.now() + 5000;
            while (!reservation && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 100));
                try {
                    reservation = await (0, broker_socket_1.reserveAccountsBrokerSocket)({ root: input.root, secret });
                }
                catch { /* Wait only for the acknowledged retirement. */ }
            }
            if (!reservation)
                throw new Error("The broker did not finish preparing recovery.");
        }
        const before = authority(input.root, secret);
        if (before.fingerprint !== input.expectedFingerprint)
            throw new Error("Account recovery findings changed. Refresh Doctor.");
        const account = before.accounts.find(a => a.entry.opaqueAccountId === input.accountId && !a.valid);
        if (!account)
            throw new Error("This account does not need recovery.");
        await input.prepareDesktop?.();
        assertIdle(account.home);
        const target = (0, node_path_1.join)(account.home, "auth.json");
        const stat = (0, node_fs_1.lstatSync)(target);
        prior = (0, native_auth_binding_1.readNativeAuthPrivateFileV1)(target);
        stagedHome = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)(input.root, ".auth-recovery-"));
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(stagedHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: "wx" });
        await input.login(stagedHome);
        try {
            (0, native_auth_binding_1.readNativeExternalTokensV1)(stagedHome, account.entry, secret);
        }
        catch {
            throw new Error(`That login is not ${account.label}. Its credentials were not changed. Use Switch account to use your other account, or reconnect the original account.`);
        }
        if (authority(input.root, secret).fingerprint !== before.fingerprint)
            throw new Error("Account recovery findings changed during login.");
        assertIdle(account.home);
        const current = (0, native_auth_binding_1.readNativeAuthPrivateFileV1)(target);
        const currentStat = (0, node_fs_1.lstatSync)(target);
        try {
            if (!current.equals(prior) || currentStat.ino !== stat.ino || currentStat.dev !== stat.dev)
                throw new Error("Credentials changed during login.");
        }
        finally {
            current.fill(0);
        }
        const fresh = (0, native_auth_binding_1.readNativeAuthPrivateFileV1)((0, node_path_1.join)(stagedHome, "auth.json"));
        const suffix = (0, node_crypto_1.randomBytes)(16).toString("hex");
        const replacement = (0, node_path_1.join)(account.home, `.auth-recovery-${suffix}`);
        const backup = (0, node_path_1.join)(account.home, `.auth-before-recovery-${suffix}`);
        try {
            (0, node_fs_1.writeFileSync)(backup, prior, { mode: 0o600, flag: "wx" });
            (0, node_fs_1.writeFileSync)(replacement, fresh, { mode: 0o600, flag: "wx" });
            for (const path of [backup, replacement]) {
                const fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
                try {
                    (0, node_fs_1.fsyncSync)(fd);
                }
                finally {
                    (0, node_fs_1.closeSync)(fd);
                }
            }
            // Revalidate immediately before the only credential mutation.
            if (authority(input.root, secret).fingerprint !== before.fingerprint || (0, node_fs_1.lstatSync)(target).ino !== stat.ino)
                throw new Error("Credentials changed before publication.");
            (0, node_fs_1.renameSync)(replacement, target);
            const fd = (0, node_fs_1.openSync)(account.home, node_fs_1.constants.O_RDONLY);
            try {
                (0, node_fs_1.fsyncSync)(fd);
            }
            finally {
                (0, node_fs_1.closeSync)(fd);
            }
            try {
                (0, native_auth_binding_1.readNativeExternalTokensV1)(account.home, account.entry, secret);
            }
            catch {
                (0, node_fs_1.renameSync)(backup, target);
                throw new Error("Reconnect verification failed; prior credentials restored.");
            }
        }
        finally {
            fresh.fill(0);
        }
        return inspectNativeAuthenticationAtRoot(input.root);
    }
    finally {
        prior?.fill(0);
        if (stagedHome)
            (0, node_fs_1.rmSync)(stagedHome, { recursive: true, force: true });
        await reservation?.close();
        secret.fill(0);
    }
}
//# sourceMappingURL=doctor-auth.js.map
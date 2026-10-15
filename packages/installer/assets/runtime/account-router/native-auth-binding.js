"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NATIVE_AUTH_BINDING_FILE_V1 = void 0;
exports.readNativeAuthPrivateFileV1 = readNativeAuthPrivateFileV1;
exports.readNativeExternalTokensV1 = readNativeExternalTokensV1;
exports.readNativeSavedProfileV1 = readNativeSavedProfileV1;
exports.readNativeAuthBindingV1 = readNativeAuthBindingV1;
exports.readNativeAuthBindingAuthorityV1 = readNativeAuthBindingAuthorityV1;
exports.prepareNativeAuthBindingV1 = prepareNativeAuthBindingV1;
exports.publishPreparedNativeAuthBindingV1 = publishPreparedNativeAuthBindingV1;
exports.ensureNativeExecutionHomesV1 = ensureNativeExecutionHomesV1;
const persistent_directory_identity_1 = require("./persistent-directory-identity");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const types_1 = require("./types");
const native_history_1 = require("./native-history");
exports.NATIVE_AUTH_BINDING_FILE_V1 = "native-auth-binding.v1.json";
const EXECUTION_HOME_RECEIPT = "native-execution-home.v1.json";
const executionReceiptFile = (account) => `accounts/${account}/native-execution-home.v1/${EXECUTION_HOME_RECEIPT}`;
const entryExists = (path) => {
    try {
        (0, node_fs_1.lstatSync)(path);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
};
const fail = () => { throw new Error("native authentication binding unavailable"); };
const digest = (bytes) => `sha256:${(0, node_crypto_1.createHash)("sha256").update(bytes).digest("hex")}`;
const encode = (value) => JSON.stringify(value);
function sameSignature(left, right) {
    return typeof right === "string" && Buffer.byteLength(left) === Buffer.byteLength(right) && (0, node_crypto_1.timingSafeEqual)(Buffer.from(left), Buffer.from(right));
}
const signature = (value, secret) => `hmac-sha256:${(0, node_crypto_1.createHmac)("sha256", secret).update(`native-auth-binding:v1\0${encode(value)}`).digest("hex")}`;
/** Owner-only no-follow stable reads. Buffers returned here must never cross IPC to a renderer. */
function readNativeAuthPrivateFileV1(path, maximum = 256 * 1024) {
    let fd;
    try {
        fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
        const a = (0, node_fs_1.fstatSync)(fd);
        if (!a.isFile() || a.nlink !== 1 || a.uid !== process.getuid?.() || (a.mode & 0o7077) !== 0 || a.size < 1 || a.size > maximum)
            return fail();
        const bytes = Buffer.alloc(a.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = (0, node_fs_1.readSync)(fd, bytes, offset, bytes.length - offset, offset);
            if (!count)
                return fail();
            offset += count;
        }
        const b = (0, node_fs_1.fstatSync)(fd);
        const c = (0, node_fs_1.lstatSync)(path);
        if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs || c.dev !== a.dev || c.ino !== a.ino || c.isSymbolicLink()) {
            bytes.fill(0);
            return fail();
        }
        return bytes;
    }
    catch {
        return fail();
    }
    finally {
        if (fd !== undefined)
            (0, node_fs_1.closeSync)(fd);
    }
}
function directory(path) {
    if (!(0, node_path_1.isAbsolute)(path) || (0, node_path_1.resolve)(path) !== path || (0, node_fs_1.realpathSync)(path) !== path)
        return fail();
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0)
        return fail();
    return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}
function overlaps(a, b) { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function authHomeLocationSafe(home, stateRoot, account) {
    if (!overlaps(home, stateRoot))
        return true;
    if (home !== (0, node_path_1.join)(stateRoot, "accounts", account, "execution-home"))
        return false;
    directory((0, node_path_1.join)(stateRoot, "accounts"));
    directory((0, node_path_1.join)(stateRoot, "accounts", account));
    return true;
}
function parseAuth(home) {
    const bytes = readNativeAuthPrivateFileV1((0, node_path_1.join)(home, "auth.json"));
    try {
        const value = JSON.parse(bytes.toString("utf8"));
        if (!(0, types_1.isPlainRecord)(value) || !(0, types_1.isPlainRecord)(value.tokens))
            return fail();
        return value.tokens;
    }
    catch {
        return fail();
    }
    finally {
        bytes.fill(0);
    }
}
function proveIdentity(home, entry, secret) {
    const tokens = parseAuth(home);
    const raw = tokens.account_id;
    if (typeof raw !== "string" || (0, native_history_1.nativeHistoryAuthIdentityHmacV1)(raw, secret) !== entry.authIdentityHmac
        || `ar_${(0, node_crypto_1.createHmac)("sha256", secret).update(`account-router:v1:${raw}`).digest("base64url")}` !== entry.opaqueAccountId)
        return fail();
    return tokens;
}
function readNativeExternalTokensV1(home, entry, secret) {
    const tokens = proveIdentity(home, entry, secret);
    if (typeof tokens.access_token !== "string" || !tokens.access_token || tokens.access_token.length > 128 * 1024 || /[\s\x00-\x1f]/.test(tokens.access_token))
        return fail();
    return { accessToken: tokens.access_token, chatgptAccountId: tokens.account_id, chatgptPlanType: null };
}
/** Saved credential display facts grant no authentication or mutation authority. */
function readNativeSavedProfileV1(home, entry, secret) {
    const tokens = proveIdentity(home, entry, secret);
    if (typeof tokens.id_token !== "string" || tokens.id_token.length > 128 * 1024)
        return null;
    const parts = tokens.id_token.split(".");
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)))
        return null;
    const bytes = Buffer.from(parts[1], "base64url");
    try {
        const claims = JSON.parse(bytes.toString("utf8"));
        if (!(0, types_1.isPlainRecord)(claims) || !(0, types_1.isPlainRecord)(claims["https://api.openai.com/auth"]))
            return null;
        const auth = claims["https://api.openai.com/auth"];
        // Do not treat an arbitrary email claim beside a bound account_id as the
        // identity of that account. The stored token must name the same account.
        if (auth.chatgpt_account_id !== tokens.account_id)
            return null;
        const email = claims.email;
        if (typeof email !== "string" || email.length > 254 || /[\s\x00-\x1f\x7f]/.test(email))
            return null;
        const parts = email.split("@");
        const local = parts[0], domain = parts[1]?.toLowerCase();
        if (parts.length !== 2 || !local || !domain || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(local)
            || !/^(?=.{1,80}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(domain))
            return null;
        const visible = local.slice(0, Math.min(3, local.length));
        const plan = typeof auth.chatgpt_plan_type === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(auth.chatgpt_plan_type) ? auth.chatgpt_plan_type : null;
        return { identifierMasked: `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}@${domain}`, plan, avatarUrl: null };
    }
    catch {
        return null;
    }
    finally {
        bytes.fill(0);
    }
}
/** Absence preserves legacy auth. Malformed or changed companions fail closed. */
function readNativeAuthBindingV1(stateRoot, source, secret) {
    const binding = readNativeAuthBindingAuthorityV1(stateRoot, source, secret);
    for (const entry of binding?.accounts ?? [])
        proveIdentity(entry.authHome, entry, secret);
    return binding;
}
/** Recovery-only authority. Verifies signatures and paths, never claims credentials are valid. */
function readNativeAuthBindingAuthorityV1(stateRoot, source, secret) {
    const path = (0, node_path_1.join)(stateRoot, exports.NATIVE_AUTH_BINDING_FILE_V1);
    try {
        (0, node_fs_1.lstatSync)(path);
    }
    catch (error) {
        if (error.code === "ENOENT"
            && !source.accounts.some(account => entryExists((0, node_path_1.join)(stateRoot, executionReceiptFile(account.opaqueAccountId)))))
            return null;
        return fail();
    }
    directory(stateRoot);
    const bytes = readNativeAuthPrivateFileV1(path, 64 * 1024);
    try {
        const value = JSON.parse(bytes.toString("utf8"));
        if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).sort().join() !== "accounts,kind,signature,sourceFingerprint,version" || value.version !== 1 || value.kind !== "account-router-native-auth-binding" || !Array.isArray(value.accounts) || value.accounts.length < 1 || value.accounts.length > source.accounts.length)
            return fail();
        const entries = [];
        for (const item of value.accounts) {
            if (!(0, types_1.isPlainRecord)(item) || Object.keys(item).sort().join() !== "authHome,authHomeIdentity,authIdentityHmac,opaqueAccountId" || typeof item.authHome !== "string")
                return fail();
            const original = source.accounts.find((a) => a.opaqueAccountId === item.opaqueAccountId);
            const identity = item.authHomeIdentity;
            if (!original || item.authIdentityHmac !== original.authIdentityHmac || !(0, types_1.isPlainRecord)(identity)
                || Object.keys(identity).sort().join() !== "device,inode,mode,uid"
                || ![identity.device, identity.inode, identity.uid, identity.mode].every((v) => Number.isSafeInteger(v) && v >= 0)
                || entries.some((entry) => entry.opaqueAccountId === original.opaqueAccountId))
                return fail();
            entries.push({ opaqueAccountId: original.opaqueAccountId, authHome: item.authHome,
                authHomeIdentity: { device: identity.device, inode: identity.inode, uid: identity.uid, mode: identity.mode },
                authIdentityHmac: original.authIdentityHmac });
        }
        const unsigned = { version: 1, kind: "account-router-native-auth-binding", sourceFingerprint: value.sourceFingerprint, accounts: entries };
        // Verify the authority before opening any path named by the companion.
        if (secret.length !== 32 || !sameSignature(signature(unsigned, secret), value.signature))
            return fail();
        const sourceBytes = readNativeAuthPrivateFileV1((0, node_path_1.join)(stateRoot, "native-history-source.v1.json"), 64 * 1024);
        try {
            if (value.sourceFingerprint !== digest(sourceBytes))
                return fail();
        }
        finally {
            sourceBytes.fill(0);
        }
        for (const entry of entries) {
            if (!(0, persistent_directory_identity_1.matchesPersistentDirectoryIdentity)({ stateRoot, secret, path: entry.authHome, expected: entry.authHomeIdentity, authorityFile: exports.NATIVE_AUTH_BINDING_FILE_V1, accountId: entry.opaqueAccountId })
                || source.accounts.some((a) => overlaps(entry.authHome, a.codexHome) || overlaps(entry.authHome, a.sqliteHome))
                || !authHomeLocationSafe(entry.authHome, stateRoot, entry.opaqueAccountId)
                || entries.some((other) => other !== entry && overlaps(other.authHome, entry.authHome)))
                return fail();
        }
        const baseFingerprint = digest(bytes), accounts = [...entries], receipts = [];
        for (const original of source.accounts) {
            const authorityFile = executionReceiptFile(original.opaqueAccountId), receiptPath = (0, node_path_1.join)(stateRoot, authorityFile);
            if (!entryExists(receiptPath))
                continue;
            directory((0, node_path_1.join)(stateRoot, "accounts", original.opaqueAccountId, "native-execution-home.v1"));
            const receiptBytes = readNativeAuthPrivateFileV1(receiptPath, 64 * 1024);
            try {
                const receipt = JSON.parse(receiptBytes.toString("utf8"));
                if (!(0, types_1.isPlainRecord)(receipt) || Object.keys(receipt).sort().join() !== "baseFingerprint,entry,kind,signature,sourceFingerprint,version"
                    || receipt.version !== 1 || receipt.kind !== "account-router-native-execution-home" || receipt.baseFingerprint !== baseFingerprint
                    || receipt.sourceFingerprint !== unsigned.sourceFingerprint || !(0, types_1.isPlainRecord)(receipt.entry))
                    return fail();
                const { signature: signed, ...body } = receipt;
                const expected = `hmac-sha256:${(0, node_crypto_1.createHmac)("sha256", secret).update(`native-execution-home:v1\0${encode(body)}`).digest("hex")}`;
                if (!sameSignature(expected, signed))
                    return fail();
                const entry = receipt.entry;
                if (Object.keys(entry).sort().join() !== "authHome,authHomeIdentity,authIdentityHmac,opaqueAccountId"
                    || entry.opaqueAccountId !== original.opaqueAccountId || entry.authIdentityHmac !== original.authIdentityHmac
                    || entry.authHome !== (0, node_path_1.join)(stateRoot, "accounts", original.opaqueAccountId, "execution-home")
                    || accounts.some(account => account.opaqueAccountId === entry.opaqueAccountId || overlaps(account.authHome, entry.authHome))
                    || source.accounts.some(account => overlaps(entry.authHome, account.codexHome) || overlaps(entry.authHome, account.sqliteHome))
                    || !authHomeLocationSafe(entry.authHome, stateRoot, entry.opaqueAccountId)
                    || !(0, persistent_directory_identity_1.matchesPersistentDirectoryIdentity)({ stateRoot, secret, path: entry.authHome, expected: entry.authHomeIdentity,
                        authorityFile, accountId: entry.opaqueAccountId }))
                    return fail();
                accounts.push(entry);
                receipts.push(digest(receiptBytes));
            }
            finally {
                receiptBytes.fill(0);
            }
        }
        return { document: { ...unsigned, signature: value.signature }, accounts,
            fingerprint: receipts.length ? digest(Buffer.from(encode([baseFingerprint, ...receipts]))) : baseFingerprint };
    }
    catch {
        return fail();
    }
    finally {
        bytes.fill(0);
    }
}
const prepared = new WeakMap();
/** Offline-only preparation. No original credentials are read and no source document is rewritten. */
function prepareNativeAuthBindingV1(input) {
    directory(input.stateRoot);
    if ((0, node_fs_1.existsSync)((0, node_path_1.join)(input.stateRoot, persistent_directory_identity_1.PERSISTENT_IDENTITIES_JOURNAL)))
        return fail();
    try {
        (0, node_fs_1.lstatSync)((0, node_path_1.join)(input.stateRoot, exports.NATIVE_AUTH_BINDING_FILE_V1));
        return fail();
    }
    catch (error) {
        if (error.code !== "ENOENT")
            return fail();
    }
    const bytes = readNativeAuthPrivateFileV1((0, node_path_1.join)(input.stateRoot, "native-history-source.v1.json"), 64 * 1024);
    try {
        if (digest(bytes) !== input.expectedSourceFingerprint)
            return fail();
        const source = (0, native_history_1.parseNativeHistorySourceV1)(JSON.parse(bytes.toString("utf8")), input.config, input.secret);
        if (!source || !input.accounts.length || input.accounts.length > source.accounts.length)
            return fail();
        for (const account of source.accounts) {
            for (const [path, expected] of [[account.codexHome, account.codexHomeIdentity], [account.sqliteHome, account.sqliteHomeIdentity]]) {
                const stat = (0, node_fs_1.lstatSync)(path);
                if ((0, node_fs_1.realpathSync)(path) !== path || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0
                    || !(0, persistent_directory_identity_1.matchesPersistentDirectoryIdentity)({ stateRoot: input.stateRoot, secret: input.secret, path, expected, authorityFile: "native-history-source.v1.json", accountId: account.opaqueAccountId }))
                    return fail();
            }
        }
        const accounts = input.accounts.map((item) => {
            const original = source.accounts.find((a) => a.opaqueAccountId === item.opaqueAccountId);
            if (!original || input.accounts.filter((a) => a.opaqueAccountId === item.opaqueAccountId).length !== 1
                || !authHomeLocationSafe(item.authHome, input.stateRoot, original.opaqueAccountId) || source.accounts.some((a) => overlaps(item.authHome, a.codexHome) || overlaps(item.authHome, a.sqliteHome))
                || input.accounts.some((a) => a !== item && overlaps(item.authHome, a.authHome)))
                return fail();
            const entry = { opaqueAccountId: original.opaqueAccountId, authHome: item.authHome, authHomeIdentity: directory(item.authHome), authIdentityHmac: original.authIdentityHmac };
            readNativeExternalTokensV1(item.authHome, entry, input.secret);
            return entry;
        }).sort((a, b) => a.opaqueAccountId.localeCompare(b.opaqueAccountId));
        const unsigned = { version: 1, kind: "account-router-native-auth-binding", sourceFingerprint: digest(bytes), accounts };
        const result = Object.freeze({ sourceFingerprint: digest(bytes), accounts: accounts.map(({ opaqueAccountId, authHome }) => ({ opaqueAccountId, authHome })) });
        prepared.set(result, { stateRoot: input.stateRoot, config: input.config, secret: Buffer.from(input.secret), bytes: Buffer.from(`${encode({ ...unsigned, signature: signature(unsigned, input.secret) })}\n`), sourceFingerprint: digest(bytes) });
        return result;
    }
    finally {
        bytes.fill(0);
    }
}
/** One exclusive atomic publication. Existing evidence is never overwritten. Parent owns the offline writer census. */
function publishPreparedNativeAuthBindingV1(value) {
    const plan = prepared.get(value);
    if (!plan)
        return fail();
    const fresh = prepareNativeAuthBindingV1({ ...plan, expectedSourceFingerprint: plan.sourceFingerprint, accounts: value.accounts });
    const rechecked = prepared.get(fresh);
    if (!plan.bytes.equals(rechecked.bytes))
        return fail();
    const target = (0, node_path_1.join)(plan.stateRoot, exports.NATIVE_AUTH_BINDING_FILE_V1);
    const temporary = (0, node_path_1.join)(plan.stateRoot, `.native-auth-binding-${(0, node_crypto_1.randomBytes)(16).toString("hex")}`);
    (0, node_fs_1.writeFileSync)(temporary, plan.bytes, { mode: 0o600, flag: "wx" });
    const fd = (0, node_fs_1.openSync)(temporary, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
    try {
        (0, node_fs_1.fsyncSync)(fd);
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
    try {
        (0, node_fs_1.linkSync)(temporary, target);
    }
    finally {
        (0, node_fs_1.unlinkSync)(temporary);
    }
    const rootFd = (0, node_fs_1.openSync)(plan.stateRoot, node_fs_1.constants.O_RDONLY);
    try {
        (0, node_fs_1.fsyncSync)(rootFd);
    }
    finally {
        (0, node_fs_1.closeSync)(rootFd);
    }
    try {
        if (process.platform === "darwin") {
            const proposal = (0, persistent_directory_identity_1.preparePersistentIdentityGeneration)({ stateRoot: plan.stateRoot, secret: plan.secret,
                verify: () => (0, native_history_1.readAndPreflightNativeHistorySourceStaticV1)(plan.stateRoot, plan.config, plan.secret).state === "ready" });
            (0, persistent_directory_identity_1.journalAndPublishPersistentIdentityGeneration)(plan.stateRoot, plan.secret, proposal);
        }
    }
    finally {
        plan.secret.fill(0);
        rechecked.secret.fill(0);
        prepared.delete(fresh);
        prepared.delete(value);
    }
}
/**
 * Called only by the elected broker before admitting children. Complete an
 * older partial migration without replacing its signed registration. Each
 * additional original account gets one immutable, account-specific receipt.
 */
function ensureNativeExecutionHomesV1(input) {
    const { stateRoot, config, secret } = input;
    if ((0, node_fs_1.existsSync)((0, node_path_1.join)(stateRoot, persistent_directory_identity_1.PERSISTENT_IDENTITIES_JOURNAL)))
        return fail();
    const initial = (0, native_history_1.readAndPreflightNativeHistorySourceStaticV1)(stateRoot, config, secret);
    if (initial.state !== "ready")
        return fail();
    const source = initial.binding.source, sourceFingerprint = initial.binding.sourceDocumentFingerprint;
    const prior = readNativeAuthBindingV1(stateRoot, source, secret);
    if (!prior)
        throw new Error("Stock account execution-home migration requires an existing signed auth binding");
    const missing = config.accounts.filter(account => account.included && !prior?.accounts.some(entry => entry.opaqueAccountId === account.opaqueAccountId));
    const staged = [];
    const authorized = () => missing.every(account => input.authorizeCopy(account.opaqueAccountId, (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId, "execution-home")));
    if (missing.length && !authorized())
        throw new Error("Stock account execution-home migration requires its original account and destination to be idle");
    for (const account of missing) {
        const original = source.accounts.find(entry => entry.opaqueAccountId === account.opaqueAccountId);
        if (!original)
            throw new Error("Stock account execution-home migration requires an original signed account");
        readNativeExternalTokensV1(original.codexHome, original, secret);
        const home = (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId, "execution-home");
        for (const path of [(0, node_path_1.join)(stateRoot, "accounts"), (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId), home]) {
            if (!(0, node_fs_1.existsSync)(path))
                (0, node_fs_1.mkdirSync)(path, { mode: 0o700 });
            directory(path);
        }
        if ((0, node_fs_1.readdirSync)(home).some(name => name !== "auth.json"))
            throw new Error("Unregistered execution-home contains data; retain it for recovery");
        const bytes = readNativeAuthPrivateFileV1((0, node_path_1.join)(original.codexHome, "auth.json"));
        try {
            const target = (0, node_path_1.join)(home, "auth.json");
            if ((0, node_fs_1.existsSync)(target)) {
                const stagedBytes = readNativeAuthPrivateFileV1(target);
                try {
                    if (!bytes.equals(stagedBytes))
                        throw new Error("Unregistered execution-home authentication changed; retain it for recovery");
                }
                finally {
                    stagedBytes.fill(0);
                }
            }
            else {
                // Rename a complete directory, never an incomplete credential file.
                // POSIX refuses to replace a nonempty destination directory. The
                // elected broker owns publication; a raced auth file is preserved.
                const staging = (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId, `.execution-home-${(0, node_crypto_1.randomBytes)(16).toString("hex")}.staging`);
                (0, node_fs_1.mkdirSync)(staging, { mode: 0o700 });
                const fd = (0, node_fs_1.openSync)((0, node_path_1.join)(staging, "auth.json"), node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_WRONLY | node_fs_1.constants.O_NOFOLLOW, 0o600);
                try {
                    (0, node_fs_1.writeFileSync)(fd, bytes);
                    (0, node_fs_1.fsyncSync)(fd);
                }
                finally {
                    (0, node_fs_1.closeSync)(fd);
                }
                const stagingFd = (0, node_fs_1.openSync)(staging, node_fs_1.constants.O_RDONLY);
                try {
                    (0, node_fs_1.fsyncSync)(stagingFd);
                }
                finally {
                    (0, node_fs_1.closeSync)(stagingFd);
                }
                if (!authorized() || (0, node_fs_1.readdirSync)(home).length)
                    return fail();
                directory(home);
                (0, node_fs_1.renameSync)(staging, home);
                const parentFd = (0, node_fs_1.openSync)((0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId), node_fs_1.constants.O_RDONLY);
                try {
                    (0, node_fs_1.fsyncSync)(parentFd);
                }
                finally {
                    (0, node_fs_1.closeSync)(parentFd);
                }
            }
            readNativeExternalTokensV1(home, original, secret);
            const current = readNativeAuthPrivateFileV1((0, node_path_1.join)(original.codexHome, "auth.json"));
            try {
                if (!bytes.equals(current) || !authorized())
                    return fail();
            }
            finally {
                current.fill(0);
            }
            const fd = (0, node_fs_1.openSync)(home, node_fs_1.constants.O_RDONLY);
            try {
                (0, node_fs_1.fsyncSync)(fd);
            }
            finally {
                (0, node_fs_1.closeSync)(fd);
            }
            staged.push({ opaqueAccountId: original.opaqueAccountId, authHome: home });
        }
        finally {
            bytes.fill(0);
        }
    }
    for (const account of staged) {
        const fresh = (0, native_history_1.readAndPreflightNativeHistorySourceStaticV1)(stateRoot, config, secret);
        if (fresh.state !== "ready" || fresh.binding.sourceDocumentFingerprint !== sourceFingerprint
            || !authorized() || readNativeAuthBindingV1(stateRoot, source, secret)?.accounts.some(entry => entry.opaqueAccountId === account.opaqueAccountId))
            return fail();
        const baseBytes = readNativeAuthPrivateFileV1((0, node_path_1.join)(stateRoot, exports.NATIVE_AUTH_BINDING_FILE_V1), 64 * 1024);
        try {
            // Bind the exact original document; it and every prior account remain intact.
            const original = source.accounts.find(entry => entry.opaqueAccountId === account.opaqueAccountId);
            const originalAuth = readNativeAuthPrivateFileV1((0, node_path_1.join)(original.codexHome, "auth.json"));
            const copiedAuth = readNativeAuthPrivateFileV1((0, node_path_1.join)(account.authHome, "auth.json"));
            try {
                if (!originalAuth.equals(copiedAuth))
                    return fail();
            }
            finally {
                originalAuth.fill(0);
                copiedAuth.fill(0);
            }
            const entry = { ...account, authHomeIdentity: directory(account.authHome), authIdentityHmac: original.authIdentityHmac };
            const body = { version: 1, kind: "account-router-native-execution-home", sourceFingerprint, baseFingerprint: digest(baseBytes), entry };
            const signature = `hmac-sha256:${(0, node_crypto_1.createHmac)("sha256", secret).update(`native-execution-home:v1\0${encode(body)}`).digest("hex")}`;
            const receiptRoot = (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId, "native-execution-home.v1");
            const stagingRoot = `${receiptRoot}.${(0, node_crypto_1.randomBytes)(16).toString("hex")}.staging`;
            (0, node_fs_1.mkdirSync)(stagingRoot, { mode: 0o700 });
            const temporary = (0, node_path_1.join)(stagingRoot, EXECUTION_HOME_RECEIPT);
            const fd = (0, node_fs_1.openSync)(temporary, node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_WRONLY | node_fs_1.constants.O_NOFOLLOW, 0o600);
            try {
                (0, node_fs_1.writeFileSync)(fd, encode({ ...body, signature }) + "\n");
                (0, node_fs_1.fsyncSync)(fd);
            }
            finally {
                (0, node_fs_1.closeSync)(fd);
            }
            const stagingFd = (0, node_fs_1.openSync)(stagingRoot, node_fs_1.constants.O_RDONLY);
            try {
                (0, node_fs_1.fsyncSync)(stagingFd);
            }
            finally {
                (0, node_fs_1.closeSync)(stagingFd);
            }
            if (entryExists(receiptRoot) || !authorized())
                return fail();
            // A published nonempty receipt directory cannot be replaced by rename.
            // No hard-link window can strand a valid receipt with nlink === 2.
            (0, node_fs_1.renameSync)(stagingRoot, receiptRoot);
            const rootFd = (0, node_fs_1.openSync)((0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId), node_fs_1.constants.O_RDONLY);
            try {
                (0, node_fs_1.fsyncSync)(rootFd);
            }
            finally {
                (0, node_fs_1.closeSync)(rootFd);
            }
        }
        finally {
            baseBytes.fill(0);
        }
    }
    // An interrupted publication may have its immutable receipt but not its
    // persistent anchors. Exact-device validation remains required until sealed.
    const identities = (0, persistent_directory_identity_1.readPersistentIdentityGeneration)(stateRoot, secret);
    const unanchored = source.accounts.some(account => entryExists((0, node_path_1.join)(stateRoot, executionReceiptFile(account.opaqueAccountId)))
        && !identities?.document.anchors.some(anchor => anchor.authorityFile === executionReceiptFile(account.opaqueAccountId)));
    if (process.platform === "darwin" && (staged.length || unanchored)) {
        const proposal = (0, persistent_directory_identity_1.preparePersistentIdentityGeneration)({ stateRoot, secret,
            verify: () => (0, native_history_1.readAndPreflightNativeHistorySourceStaticV1)(stateRoot, config, secret).state === "ready" });
        (0, persistent_directory_identity_1.journalAndPublishPersistentIdentityGeneration)(stateRoot, secret, proposal);
    }
    if ((0, native_history_1.readAndPreflightNativeHistorySourceStaticV1)(stateRoot, config, secret).state !== "ready")
        return fail();
}
//# sourceMappingURL=native-auth-binding.js.map
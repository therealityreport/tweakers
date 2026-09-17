"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PERSISTENT_IDENTITIES_JOURNAL = exports.PERSISTENT_IDENTITIES_FILE = void 0;
exports.parsePersistentIdentityGeneration = parsePersistentIdentityGeneration;
exports.readPersistentIdentityGeneration = readPersistentIdentityGeneration;
exports.nativeVolumeUuid = nativeVolumeUuid;
exports.matchesPersistentDirectoryIdentity = matchesPersistentDirectoryIdentity;
exports.preparePersistentIdentityGeneration = preparePersistentIdentityGeneration;
exports.persistentIdentityProposalFingerprint = persistentIdentityProposalFingerprint;
exports.publishPersistentIdentityGeneration = publishPersistentIdentityGeneration;
exports.validatePersistentIdentityProposal = validatePersistentIdentityProposal;
exports.journalAndPublishPersistentIdentityGeneration = journalAndPublishPersistentIdentityGeneration;
exports.restorePriorPersistentIdentityGeneration = restorePriorPersistentIdentityGeneration;
const node_async_hooks_1 = require("node:async_hooks");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/** Original signed documents stay byte-for-byte intact. Only this companion is new. */
exports.PERSISTENT_IDENTITIES_FILE = "native-storage-identities.v2.json";
exports.PERSISTENT_IDENTITIES_JOURNAL = "native-storage-identities-repair.v2.json";
const ARCHIVE = "native-storage-identities";
const MAX_BYTES = 256 * 1024;
const captures = new node_async_hooks_1.AsyncLocalStorage();
const digest = (value) => `sha256:${(0, node_crypto_1.createHash)("sha256").update(value).digest("hex")}`;
const exact = (value, keys) => Object.keys(value).sort().join() === keys.sort().join();
const key = (anchor) => JSON.stringify([anchor.authorityFile, anchor.accountId, anchor.path]);
const fail = () => { throw new Error("persistent storage identity unavailable"); };
const safeDigest = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
function authorityName(value) {
    return ["native-history-source.v1.json", "native-auth-binding.v1.json", "shared-native-mode.v1.json"].includes(value)
        || /^accounts\/ar_[A-Za-z0-9_-]{16,128}\/native-history-enrollment-receipt\.v1\.json$/.test(value);
}
function privateRoot(path) {
    const s = (0, node_fs_1.lstatSync)(path);
    if (!(0, node_path_1.isAbsolute)(path) || (0, node_path_1.resolve)(path) !== path || (0, node_fs_1.realpathSync)(path) !== path || !s.isDirectory() || s.isSymbolicLink()
        || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0)
        fail();
}
function readPrivate(path) {
    const fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
    try {
        const a = (0, node_fs_1.fstatSync)(fd);
        if (!a.isFile() || a.nlink !== 1 || a.uid !== process.getuid?.() || (a.mode & 0o7077) !== 0 || a.size < 1 || a.size > MAX_BYTES)
            fail();
        const bytes = (0, node_fs_1.readFileSync)(fd);
        const b = (0, node_fs_1.fstatSync)(fd), c = (0, node_fs_1.lstatSync)(path);
        if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs
            || c.isSymbolicLink() || c.dev !== a.dev || c.ino !== a.ino)
            fail();
        return bytes;
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
    return JSON.stringify(value);
}
function authorityEvidence(root, name, secret) {
    if (!authorityName(name))
        fail();
    const path = (0, node_path_1.join)(root, name);
    if ((0, node_fs_1.realpathSync)(path) !== path)
        fail();
    const bytes = readPrivate(path), documentFingerprint = digest(bytes);
    if (name !== "shared-native-mode.v1.json")
        return { fingerprint: documentFingerprint, documentFingerprint };
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !exact(parsed, ["version", "kind", "sourceFingerprint", "sourceAccountId", "nativeBase", "overlay", "resolverProtocol", "resolverBinarySha256", "retiredCopyState", "signature"]))
        return fail();
    const { signature: signed, ...unsigned } = parsed;
    const mac = `hmac-sha256:${(0, node_crypto_1.createHmac)("sha256", secret).update("shared-native-mode:v1\0" + canonical(unsigned)).digest("hex")}`;
    if (typeof signed !== "string" || signed.length !== mac.length || !(0, node_crypto_1.timingSafeEqual)(Buffer.from(signed), Buffer.from(mac)))
        return fail();
    // Existing resolver CAS validates the current binary separately. It may change
    // only this field; the full signed root authority must remain identical.
    const { resolverBinarySha256: _resolver, ...rootAuthority } = unsigned;
    return { fingerprint: digest("shared-native-root-authority:v2\0" + canonical(rootAuthority)), documentFingerprint };
}
function signature(unsigned, secret) {
    if (secret.length !== 32)
        fail();
    return `hmac-sha256:${(0, node_crypto_1.createHmac)("sha256", secret).update("native-storage-identities:v2\0").update(JSON.stringify(unsigned)).digest("hex")}`;
}
function validLegacy(value) {
    return !!value && typeof value === "object" && exact(value, ["device", "inode", "uid", "mode"])
        && Object.values(value).every(n => Number.isSafeInteger(n) && n >= 0);
}
function parsePersistentIdentityGeneration(value, secret) {
    if (!value || typeof value !== "object" || !exact(value, ["version", "kind", "generation", "priorFingerprint", "anchors", "signature"]))
        return fail();
    const v = value;
    if (v.version !== 2 || v.kind !== "account-router-persistent-directory-identities" || !/^[a-f0-9-]{36}$/.test(v.generation)
        || !(v.priorFingerprint === null || safeDigest(v.priorFingerprint)) || !Array.isArray(v.anchors) || !v.anchors.length || v.anchors.length > 512)
        return fail();
    const seen = new Set();
    for (const a of v.anchors) {
        if (!a || !exact(a, ["authorityFile", "authorityFingerprint", "documentFingerprint", "accountId", "path", "legacy", "volumeUuid"])
            || typeof a.authorityFile !== "string" || !authorityName(a.authorityFile) || !safeDigest(a.authorityFingerprint) || !safeDigest(a.documentFingerprint)
            || !(a.accountId === null || (typeof a.accountId === "string" && /^ar_[A-Za-z0-9_-]{16,128}$/.test(a.accountId)))
            || typeof a.path !== "string" || !(0, node_path_1.isAbsolute)(a.path) || (0, node_path_1.resolve)(a.path) !== a.path || !validLegacy(a.legacy)
            || typeof a.volumeUuid !== "string" || !/^[a-f0-9-]{36}$/.test(a.volumeUuid) || seen.has(key(a)))
            return fail();
        seen.add(key(a));
    }
    const { signature: signed, ...unsigned } = v;
    const expected = signature(unsigned, secret);
    if (typeof signed !== "string" || signed.length !== expected.length || !(0, node_crypto_1.timingSafeEqual)(Buffer.from(signed), Buffer.from(expected)))
        return fail();
    return v;
}
function readPersistentIdentityGeneration(stateRoot, secret) {
    privateRoot(stateRoot);
    const path = (0, node_path_1.join)(stateRoot, exports.PERSISTENT_IDENTITIES_FILE);
    try {
        (0, node_fs_1.lstatSync)(path);
    }
    catch (e) {
        if (e.code === "ENOENT")
            return null;
        throw e;
    }
    const bytes = readPrivate(path);
    return { document: parsePersistentIdentityGeneration(JSON.parse(bytes.toString("utf8")), secret), fingerprint: digest(bytes) };
}
/** Native API access is synchronous and does not spawn a process on each history read. */
function nativeVolumeUuid(path) {
    // main.js bundles this module at the runtime root; CLI modules retain the
    // account-router directory. Resolve those two layouts without searching
    // outside the packaged runtime when an addon is missing.
    const runtimeRoot = (0, node_path_1.basename)(__dirname) === "account-router" ? (0, node_path_1.join)(__dirname, "..") : __dirname;
    const hostPath = __dirname.endsWith("/packages/runtime/src/account-router")
        ? (0, node_path_1.join)(__dirname, "..", "..", "..", "native-host", "dist", "tweaker_native_host.node")
        : (0, node_path_1.join)(runtimeRoot, "native", "tweaker_native_host.node");
    const host = require(hostPath);
    const value = host.volumeUuid(path);
    if (!/^[a-f0-9-]{36}$/.test(value))
        return fail();
    return value;
}
/** Caller must first validate the original authority's signature and account/path binding. */
function matchesPersistentDirectoryIdentity(input) {
    try {
        const { path, expected, stateRoot, secret } = input;
        if (!validLegacy(expected) || !(0, node_path_1.isAbsolute)(path) || (0, node_path_1.resolve)(path) !== path || (0, node_fs_1.realpathSync)(path) !== path)
            return false;
        const a = (0, node_fs_1.lstatSync)(path);
        if (!a.isDirectory() || a.isSymbolicLink() || a.uid !== process.getuid?.() || (a.mode & 0o022) !== 0
            || a.ino !== expected.inode || a.uid !== expected.uid || (a.mode & 0o7777) !== expected.mode)
            return false;
        const capture = captures.getStore();
        if (capture && capture.stateRoot !== stateRoot)
            return false;
        const generation = readPersistentIdentityGeneration(stateRoot, secret);
        const anchorKey = { path, authorityFile: input.authorityFile, accountId: input.accountId ?? null };
        const anchor = generation?.document.anchors.find(entry => key(entry) === key(anchorKey));
        if (!capture && !generation)
            return a.dev === expected.device;
        const hasAuthority = generation?.document.anchors.some(entry => entry.authorityFile === input.authorityFile) ?? false;
        const newOptionalAuthority = !hasAuthority && ["native-auth-binding.v1.json", "shared-native-mode.v1.json"].includes(input.authorityFile);
        // New optional documents retain the original exact-device contract until
        // their writer publishes the complete authority's persistent anchors.
        if (!capture && generation && !anchor)
            return newOptionalAuthority && a.dev === expected.device;
        // A published anchor may never be replaced merely because legacy fields match.
        if (anchor && canonical(anchor.legacy) !== canonical(expected))
            return false;
        if (!anchor && hasAuthority)
            return false;
        const authorizedLegacyRebind = !!capture && ((capture.allowLegacyDeviceChange && (!generation || newOptionalAuthority))
            || capture.verifiedLegacyAuthorities.has(input.authorityFile));
        if (!anchor && (!capture || (!authorizedLegacyRebind && a.dev !== expected.device)))
            return false;
        const { fingerprint, documentFingerprint } = authorityEvidence(stateRoot, input.authorityFile, secret);
        if (anchor && anchor.authorityFingerprint !== fingerprint)
            return false;
        const uuid = (capture?.volumeUuid ?? nativeVolumeUuid)(path);
        if (anchor && anchor.volumeUuid !== uuid)
            return false;
        const b = (0, node_fs_1.lstatSync)(path);
        if (a.dev !== b.dev || a.ino !== b.ino || a.uid !== b.uid || a.mode !== b.mode || (0, node_fs_1.realpathSync)(path) !== path)
            return false;
        capture?.anchors.set(key(anchorKey), anchor ?? { ...anchorKey, authorityFingerprint: fingerprint, documentFingerprint, legacy: { ...expected }, volumeUuid: uuid });
        return true;
    }
    catch {
        return false;
    }
}
/** Pure preparation. Only successful production validation can produce a signed proposal. */
function preparePersistentIdentityGeneration(input) {
    const prior = readPersistentIdentityGeneration(input.stateRoot, input.secret);
    const capture = { stateRoot: input.stateRoot, anchors: new Map(prior?.document.anchors.map(a => [key(a), a]) ?? []),
        allowLegacyDeviceChange: input.allowLegacyDeviceChange === true, verifiedLegacyAuthorities: new Set(input.verifiedLegacyAuthorities ?? []), volumeUuid: input.volumeUuid ?? nativeVolumeUuid };
    if (!captures.run(capture, input.verify) || !capture.anchors.size)
        return fail();
    if (readPersistentIdentityGeneration(input.stateRoot, input.secret)?.fingerprint !== prior?.fingerprint)
        return fail();
    const unsigned = { version: 2, kind: "account-router-persistent-directory-identities",
        generation: (0, node_crypto_1.randomUUID)(), priorFingerprint: prior?.fingerprint ?? null, anchors: [...capture.anchors.values()].sort((a, b) => key(a).localeCompare(key(b))) };
    const result = { priorFingerprint: unsigned.priorFingerprint, next: { ...unsigned, signature: signature(unsigned, input.secret) } };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES)
        return fail();
    return result;
}
function bytesFor(document) { return Buffer.from(`${JSON.stringify(document)}\n`); }
function persistentIdentityProposalFingerprint(proposal) { return digest(bytesFor(proposal.next)); }
function syncDirectory(path) { const fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY); try {
    (0, node_fs_1.fsyncSync)(fd);
}
finally {
    (0, node_fs_1.closeSync)(fd);
} }
function writeExclusive(path, bytes) {
    const fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_WRONLY | node_fs_1.constants.O_NOFOLLOW, 0o600);
    try {
        (0, node_fs_1.writeFileSync)(fd, bytes);
        (0, node_fs_1.fsyncSync)(fd);
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
}
/** Caller owns exclusive broker/metadata lifecycle. Replays accept only recorded prior or next. */
function publishPersistentIdentityGeneration(stateRoot, secret, proposal) {
    privateRoot(stateRoot);
    const next = parsePersistentIdentityGeneration(proposal.next, secret);
    if (next.priorFingerprint !== proposal.priorFingerprint)
        return fail();
    const bytes = bytesFor(next), fingerprint = digest(bytes);
    if (bytes.length > MAX_BYTES)
        return fail();
    const prior = readPersistentIdentityGeneration(stateRoot, secret);
    if (prior?.fingerprint === fingerprint)
        return fingerprint;
    if ((prior?.fingerprint ?? null) !== proposal.priorFingerprint)
        return fail();
    if (prior?.document.anchors.some(anchor => canonical(next.anchors.find(entry => key(entry) === key(anchor))) !== canonical(anchor)))
        return fail();
    // Recheck every authority and actual persistent identity before the atomic switch.
    for (const a of next.anchors) {
        if (authorityEvidence(stateRoot, a.authorityFile, secret).fingerprint !== a.authorityFingerprint)
            return fail();
        const stat = (0, node_fs_1.lstatSync)(a.path);
        if ((0, node_fs_1.realpathSync)(a.path) !== a.path || !stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== a.legacy.inode
            || stat.uid !== a.legacy.uid || (stat.mode & 0o7777) !== a.legacy.mode || nativeVolumeUuid(a.path) !== a.volumeUuid)
            return fail();
    }
    const archive = (0, node_path_1.join)(stateRoot, ARCHIVE);
    if (!(0, node_fs_1.existsSync)(archive))
        (0, node_fs_1.mkdirSync)(archive, { mode: 0o700 });
    privateRoot(archive);
    const immutable = (0, node_path_1.join)(archive, `${next.generation}.json`);
    if ((0, node_fs_1.existsSync)(immutable)) {
        if (!readPrivate(immutable).equals(bytes))
            return fail();
    }
    else
        writeExclusive(immutable, bytes);
    if (prior) {
        const previous = (0, node_path_1.join)(archive, `${prior.document.generation}.json`);
        if (!(0, node_fs_1.existsSync)(previous))
            writeExclusive(previous, bytesFor(prior.document));
    }
    syncDirectory(archive);
    const temporary = (0, node_path_1.join)(stateRoot, `.native-storage-identities-${(0, node_crypto_1.randomUUID)()}`);
    writeExclusive(temporary, bytes);
    // The whole signed companion is the atomic active-generation pointer.
    try {
        (0, node_fs_1.renameSync)(temporary, (0, node_path_1.join)(stateRoot, exports.PERSISTENT_IDENTITIES_FILE));
        syncDirectory(stateRoot);
    }
    finally {
        if ((0, node_fs_1.existsSync)(temporary))
            (0, node_fs_1.unlinkSync)(temporary);
    }
    return fingerprint;
}
/** Validate a replay without writing or changing the active generation. */
function validatePersistentIdentityProposal(stateRoot, secret, value) {
    if (!value || typeof value !== "object" || !exact(value, ["priorFingerprint", "next"]))
        return fail();
    const proposal = value;
    const next = parsePersistentIdentityGeneration(proposal.next, secret);
    if (next.priorFingerprint !== proposal.priorFingerprint || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES)
        return fail();
    const current = readPersistentIdentityGeneration(stateRoot, secret);
    if ((current?.fingerprint ?? null) !== proposal.priorFingerprint && current?.fingerprint !== persistentIdentityProposalFingerprint(proposal))
        return fail();
    if (current?.document.anchors.some(anchor => canonical(next.anchors.find(entry => key(entry) === key(anchor))) !== canonical(anchor)))
        return fail();
    for (const a of next.anchors) {
        if (authorityEvidence(stateRoot, a.authorityFile, secret).fingerprint !== a.authorityFingerprint)
            return fail();
        const stat = (0, node_fs_1.lstatSync)(a.path);
        if ((0, node_fs_1.realpathSync)(a.path) !== a.path || !stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== a.legacy.inode
            || stat.uid !== a.legacy.uid || (stat.mode & 0o7777) !== a.legacy.mode || nativeVolumeUuid(a.path) !== a.volumeUuid)
            return fail();
    }
    return proposal;
}
/** Offline metadata writers share Doctor's interruption-safe publication format. */
function journalAndPublishPersistentIdentityGeneration(stateRoot, secret, proposal) {
    const journal = (0, node_path_1.join)(stateRoot, exports.PERSISTENT_IDENTITIES_JOURNAL);
    if ((0, node_fs_1.existsSync)(journal))
        return fail();
    validatePersistentIdentityProposal(stateRoot, secret, proposal);
    const bytes = Buffer.from(`${JSON.stringify(proposal)}\n`);
    if (bytes.length > MAX_BYTES)
        return fail();
    writeExclusive(journal, bytes);
    syncDirectory(stateRoot);
    publishPersistentIdentityGeneration(stateRoot, secret, proposal);
    (0, node_fs_1.unlinkSync)(journal);
    syncDirectory(stateRoot);
}
/** Restore only the recorded predecessor while the repair owner holds its socket. */
function restorePriorPersistentIdentityGeneration(stateRoot, secret, proposal) {
    privateRoot(stateRoot);
    if (parsePersistentIdentityGeneration(proposal.next, secret).priorFingerprint !== proposal.priorFingerprint)
        return fail();
    const current = readPersistentIdentityGeneration(stateRoot, secret);
    if ((current?.fingerprint ?? null) === proposal.priorFingerprint)
        return;
    if (current?.fingerprint !== persistentIdentityProposalFingerprint(proposal))
        return fail();
    const active = (0, node_path_1.join)(stateRoot, exports.PERSISTENT_IDENTITIES_FILE);
    if (proposal.priorFingerprint === null) {
        (0, node_fs_1.unlinkSync)(active);
        syncDirectory(stateRoot);
        return;
    }
    const archive = (0, node_path_1.join)(stateRoot, ARCHIVE);
    privateRoot(archive);
    const entries = (0, node_fs_1.readdirSync)(archive);
    if (entries.length > 1024)
        return fail();
    let previous = null;
    for (const name of entries) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name))
            return fail();
        const bytes = readPrivate((0, node_path_1.join)(archive, name));
        if (digest(bytes) !== proposal.priorFingerprint)
            continue;
        const parsed = parsePersistentIdentityGeneration(JSON.parse(bytes.toString("utf8")), secret);
        if (parsed.anchors.some(anchor => canonical(proposal.next.anchors.find(entry => key(entry) === key(anchor))) !== canonical(anchor)))
            return fail();
        previous = bytes;
        break;
    }
    if (!previous)
        return fail();
    const temp = (0, node_path_1.join)(stateRoot, `.native-storage-identities-rollback-${(0, node_crypto_1.randomUUID)()}`);
    writeExclusive(temp, previous);
    (0, node_fs_1.renameSync)(temp, active);
    syncDirectory(stateRoot);
}
//# sourceMappingURL=persistent-directory-identity.js.map
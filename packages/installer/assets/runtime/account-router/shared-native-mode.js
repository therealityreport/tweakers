"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHARED_NATIVE_MODE_TRANSITION_FILE_V1 = exports.SHARED_NATIVE_MODE_FILE_V1 = void 0;
exports.readSharedNativeModeV1 = readSharedNativeModeV1;
exports.prepareSharedNativeModeV1 = prepareSharedNativeModeV1;
exports.publishSharedNativeModeV1 = publishSharedNativeModeV1;
exports.recoverSharedNativeModeV1 = recoverSharedNativeModeV1;
exports.prepareSharedNativeResolverTransitionV1 = prepareSharedNativeResolverTransitionV1;
exports.executeSharedNativeResolverTransitionV1 = executeSharedNativeResolverTransitionV1;
exports.executeSharedNativeResolverTransitionAtRootV1 = executeSharedNativeResolverTransitionAtRootV1;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const account_continuity_1 = require("./account-continuity");
const native_history_1 = require("./native-history");
const types_1 = require("./types");
exports.SHARED_NATIVE_MODE_FILE_V1 = "shared-native-mode.v1.json";
exports.SHARED_NATIVE_MODE_TRANSITION_FILE_V1 = "shared-native-mode-transition.v1.json";
const REBASE_FILE = "shared-source-rebase-intent.v1.json";
const ACCOUNT_INTENTS = ["config-materialization-intent.v1.json", "plugin-projection-intent.v1.json", "native-initial-capture-intent.v1.json"];
const fail = (reason) => { throw new Error(reason); };
const blocked = (error) => ({ state: "blocked", reason: error instanceof Error ? error.message : "shared native mode unavailable" });
const hash = (bytes) => `sha256:${(0, node_crypto_1.createHash)("sha256").update(bytes).digest("hex")}`;
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if ((0, types_1.isPlainRecord)(value))
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
}
const bytes = (value) => Buffer.from(canonical(value) + "\n");
const fingerprint = (value) => hash(bytes(value));
const sha = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => Object.keys(value).sort().join() === keys.sort().join();
function mac(value, secret, domain) {
    if (secret.length !== 32)
        return fail("invalid shared native signing key");
    return `hmac-sha256:${(0, node_crypto_1.createHmac)("sha256", secret).update(domain + "\0" + canonical(value)).digest("hex")}`;
}
function signed(value, secret, domain) { return { ...value, signature: mac(value, secret, domain) }; }
function verify(value, secret, domain) {
    const { signature, ...unsigned } = value;
    const expected = mac(unsigned, secret, domain);
    if (typeof signature !== "string" || Buffer.byteLength(signature) !== expected.length || !(0, node_crypto_1.timingSafeEqual)(Buffer.from(signature), Buffer.from(expected)))
        fail("invalid shared native signature");
}
function present(path) {
    try {
        (0, node_fs_1.lstatSync)(path);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
function directory(path, privateOnly = true) {
    if (!(0, node_path_1.isAbsolute)(path) || (0, node_path_1.resolve)(path) !== path || (0, node_fs_1.realpathSync)(path) !== path)
        return fail("noncanonical shared native root");
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & (privateOnly ? 0o7077 : 0o7022)))
        return fail("unsafe shared native root");
    return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}
function read(path) {
    const fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
    try {
        const before = (0, node_fs_1.fstatSync)(fd);
        if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o7077) || before.size < 1 || before.size > 4 * 1024 * 1024)
            return fail("unsafe shared native document");
        const result = (0, node_fs_1.readFileSync)(fd);
        const after = (0, node_fs_1.fstatSync)(fd);
        const current = (0, node_fs_1.lstatSync)(path);
        if (result.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino)
            return fail("shared native document changed");
        return result;
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
}
function sync(path) { const fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY); try {
    (0, node_fs_1.fsyncSync)(fd);
}
finally {
    (0, node_fs_1.closeSync)(fd);
} }
/** An exclusive link publishes a complete fsynced file, never a partial final document. */
function publish(path, content) {
    const temp = (0, node_path_1.join)((0, node_path_1.dirname)(path), `.shared-native-${(0, node_crypto_1.randomBytes)(16).toString("hex")}`);
    (0, node_fs_1.writeFileSync)(temp, content, { mode: 0o600, flag: "wx" });
    try {
        sync(temp);
        (0, node_fs_1.linkSync)(temp, path);
        sync((0, node_path_1.dirname)(path));
    }
    finally {
        (0, node_fs_1.unlinkSync)(temp);
        sync((0, node_path_1.dirname)(path));
    }
}
function overlap(a, b) { return a === b || a.startsWith(b + "/") || b.startsWith(a + "/"); }
function contextSafe(context) {
    directory(context.stateRoot);
    if (context.binding.stateRoot !== context.stateRoot || !(0, native_history_1.nativeHistoryBindingSafeV1)(context.binding))
        fail("native history binding changed");
    const { signature, ...source } = context.binding.source;
    if ((0, native_history_1.signNativeHistorySourceV1)(source, context.secret).signature !== signature)
        fail("native source signing key mismatch");
}
function noAccountRecovery(context) {
    for (const account of context.binding.accounts) {
        const root = (0, node_path_1.join)(context.stateRoot, "accounts", account.opaqueAccountId);
        if (present(root)) {
            directory((0, node_path_1.join)(context.stateRoot, "accounts"));
            directory(root);
        }
        for (const name of ACCOUNT_INTENTS)
            if (present((0, node_path_1.join)(root, name)))
                fail("unrelated account continuity recovery is pending");
    }
}
function sharedRoot(context) { const root = (0, node_path_1.join)(context.stateRoot, "shared-account-config"); directory(root); return root; }
function parseDocument(value, context) {
    if (!(0, types_1.isPlainRecord)(value) || !exact(value, ["version", "kind", "sourceFingerprint", "sourceAccountId", "nativeBase", "overlay", "resolverProtocol", "resolverBinarySha256", "retiredCopyState", "signature"])
        || value.version !== 1 || value.kind !== "account-router-shared-native-mode" || !sha(value.sourceFingerprint) || !(0, types_1.isOpaqueAccountId)(value.sourceAccountId)
        || value.resolverProtocol !== "shared-native-overlay-v1" || typeof value.resolverBinarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.resolverBinarySha256))
        return fail("invalid shared native registration");
    verify(value, context.secret, "shared-native-mode:v1");
    for (const root of [value.nativeBase, value.overlay]) {
        if (!(0, types_1.isPlainRecord)(root) || !exact(root, ["path", "identity"]) || typeof root.path !== "string" || !(0, types_1.isPlainRecord)(root.identity)
            || !exact(root.identity, ["device", "inode", "uid", "mode"]) || !Object.values(root.identity).every((v) => Number.isSafeInteger(v) && v >= 0))
            return fail("invalid shared native root identity");
    }
    const retired = value.retiredCopyState;
    if (!(0, types_1.isPlainRecord)(retired) || !exact(retired, ["priorSharedFingerprint", "priorPluginsFingerprint", "abortedRebaseFingerprint"]) || !sha(retired.priorSharedFingerprint) || !sha(retired.priorPluginsFingerprint) || !(retired.abortedRebaseFingerprint === null || sha(retired.abortedRebaseFingerprint)))
        return fail("invalid retired copy state");
    const document = value;
    const original = context.binding.source.accounts.find((a) => a.opaqueAccountId === document.sourceAccountId);
    if (document.sourceFingerprint !== context.binding.sourceDocumentFingerprint || document.sourceAccountId !== context.binding.source.metadataAccountId || !original
        || document.nativeBase.path !== original.codexHome || canonical(document.nativeBase.identity) !== canonical(original.codexHomeIdentity)
        || canonical(directory(document.nativeBase.path, false)) !== canonical(document.nativeBase.identity)
        || canonical(directory(document.overlay.path)) !== canonical(document.overlay.identity))
        return fail("shared native source or root changed");
    if (!document.overlay.path.startsWith(context.stateRoot + "/")
        || ["accounts", "shared-account-config"].some((name) => overlap((0, node_path_1.join)(context.stateRoot, name), document.overlay.path))
        || context.binding.accounts.some((a) => [a.codexHome, a.sqliteHome].some((root) => overlap(root, document.overlay.path))))
        return fail("shared overlay must be manager-owned and disjoint from history and continuity state");
    return document;
}
function parsePlan(value, context) {
    if (!(0, types_1.isPlainRecord)(value) || !exact(value, ["version", "kind", "document", "rebaseDocumentFingerprint", "signature"]) || value.version !== 1 || value.kind !== "account-router-shared-native-mode-transition"
        || !(value.rebaseDocumentFingerprint === null || sha(value.rebaseDocumentFingerprint)))
        return fail("invalid shared native transition");
    verify(value, context.secret, "shared-native-mode-transition:v1");
    const document = parseDocument(value.document, context);
    if ((value.rebaseDocumentFingerprint === null) !== (document.retiredCopyState.abortedRebaseFingerprint === null))
        return fail("invalid shared native retirement proof");
    return value;
}
function priorGlobals(context, document) {
    sharedRoot(context);
    if ((0, account_continuity_1.loadSharedAccountBase)(context.stateRoot)?.fingerprint !== document.retiredCopyState.priorSharedFingerprint
        || (0, account_continuity_1.loadSharedPluginsManifestV1)(context.stateRoot)?.fingerprint !== document.retiredCopyState.priorPluginsFingerprint)
        fail("copy manifests were published or changed");
}
function archiveRebasePath(context, digest) { return (0, node_path_1.join)(sharedRoot(context), `shared-source-rebase-aborted-${digest.slice(7)}.v1.json`); }
function readSharedNativeModeV1(context) {
    try {
        directory(context.stateRoot);
        if (present((0, node_path_1.join)(context.stateRoot, exports.SHARED_NATIVE_MODE_TRANSITION_FILE_V1)))
            return blocked(new Error("shared native transition recovery is pending"));
        const path = (0, node_path_1.join)(context.stateRoot, exports.SHARED_NATIVE_MODE_FILE_V1);
        if (!present(path))
            return { state: "absent" };
        contextSafe(context);
        noAccountRecovery(context);
        if (present((0, node_path_1.join)(context.stateRoot, "shared-account-config")))
            sharedRoot(context);
        if (present((0, node_path_1.join)(context.stateRoot, "shared-account-config", REBASE_FILE)))
            fail("shared source rebase recovery is pending");
        const content = read(path);
        const document = parseDocument(JSON.parse(content.toString("utf8")), context);
        return { state: "ready", document, fingerprint: hash(content), environment: { TWEAKERS_NATIVE_BASE_ROOT: document.nativeBase.path, TWEAKERS_OVERLAY_ROOT: document.overlay.path } };
    }
    catch (error) {
        return blocked(error);
    }
}
function prepareSharedNativeModeV1(input) {
    try {
        contextSafe(input);
        noAccountRecovery(input);
        if (present((0, node_path_1.join)(input.stateRoot, exports.SHARED_NATIVE_MODE_FILE_V1)) || present((0, node_path_1.join)(input.stateRoot, exports.SHARED_NATIVE_MODE_TRANSITION_FILE_V1)))
            fail("shared native registration or transition already exists");
        if (input.expectedSourceFingerprint !== input.binding.sourceDocumentFingerprint)
            fail("native source fingerprint changed");
        const shared = (0, account_continuity_1.loadSharedAccountBase)(input.stateRoot);
        const plugins = (0, account_continuity_1.loadSharedPluginsManifestV1)(input.stateRoot);
        if (!shared || !plugins)
            fail("copy manifests unavailable");
        const path = (0, node_path_1.join)(sharedRoot(input), REBASE_FILE);
        let rebaseDocumentFingerprint = null;
        if (input.expectedRebaseIntentFingerprint !== null) {
            if (!sha(input.expectedRebaseIntentFingerprint))
                fail("invalid expected rebase fingerprint");
            const preview = (0, account_continuity_1.abortUnpublishedSharedSourceRebase)({ stateRoot: input.stateRoot, accounts: input.binding.accounts, expectedIntentFingerprint: input.expectedRebaseIntentFingerprint });
            if (preview.state !== "would_abort")
                fail(preview.reason ?? "expected rebase is unavailable");
            rebaseDocumentFingerprint = hash(read(path));
        }
        else if (present(path))
            fail("unexpected shared source rebase");
        const original = input.binding.source.accounts.find((a) => a.opaqueAccountId === input.binding.source.metadataAccountId);
        const document = signed({ version: 1, kind: "account-router-shared-native-mode",
            sourceFingerprint: input.expectedSourceFingerprint, sourceAccountId: original.opaqueAccountId,
            nativeBase: { path: original.codexHome, identity: { ...original.codexHomeIdentity } }, overlay: { path: input.overlayPath, identity: directory(input.overlayPath) },
            resolverProtocol: "shared-native-overlay-v1", resolverBinarySha256: input.resolverBinarySha256,
            retiredCopyState: { priorSharedFingerprint: shared.fingerprint, priorPluginsFingerprint: plugins.fingerprint, abortedRebaseFingerprint: input.expectedRebaseIntentFingerprint } }, input.secret, "shared-native-mode:v1");
        parseDocument(document, input);
        const plan = signed({ version: 1, kind: "account-router-shared-native-mode-transition", document, rebaseDocumentFingerprint }, input.secret, "shared-native-mode-transition:v1");
        return { state: "prepared", plan, fingerprint: fingerprint(plan) };
    }
    catch (error) {
        return blocked(error);
    }
}
function finish(input, plan, transitionFingerprint) {
    contextSafe(input);
    noAccountRecovery(input);
    parsePlan(plan, input);
    priorGlobals(input, plan.document);
    const transitionPath = (0, node_path_1.join)(input.stateRoot, exports.SHARED_NATIVE_MODE_TRANSITION_FILE_V1);
    const finalPath = (0, node_path_1.join)(input.stateRoot, exports.SHARED_NATIVE_MODE_FILE_V1);
    const finalBytes = bytes(plan.document);
    const assertTransition = () => {
        contextSafe(input);
        noAccountRecovery(input);
        parsePlan(plan, input);
        priorGlobals(input, plan.document);
        if (hash(read(transitionPath)) !== transitionFingerprint)
            fail("shared native transition changed");
        if (present(finalPath) && !read(finalPath).equals(finalBytes))
            fail("conflicting shared native registration");
    };
    assertTransition();
    const rebasePath = (0, node_path_1.join)(sharedRoot(input), REBASE_FILE);
    const retired = plan.document.retiredCopyState.abortedRebaseFingerprint;
    if (retired !== null) {
        if (present(rebasePath)) {
            const rebaseBytes = read(rebasePath);
            if (hash(rebaseBytes) !== plan.rebaseDocumentFingerprint)
                fail("pending rebase document changed");
            const journal = JSON.parse(rebaseBytes.toString("utf8"));
            if (!(0, types_1.isPlainRecord)(journal) || !Array.isArray(journal.accounts))
                fail("invalid pending rebase accounts");
            for (const entry of journal.accounts) {
                if (!(0, types_1.isPlainRecord)(entry) || typeof entry.opaqueAccountId !== "string")
                    fail("invalid pending rebase account");
                const evidence = input.accountWriteEvidence?.[entry.opaqueAccountId];
                if (!evidence?.accountChildAbsent || typeof evidence.nativeWriterCensus !== "function")
                    fail("native copy retirement requires fresh writer evidence");
            }
            const result = (0, account_continuity_1.abortUnpublishedSharedSourceRebase)({ stateRoot: input.stateRoot, accounts: input.binding.accounts,
                expectedIntentFingerprint: retired, accountWriteEvidence: input.accountWriteEvidence, apply: true });
            if (result.state !== "aborted")
                fail(result.reason ?? "shared rebase could not be retired");
        }
        if (hash(read(archiveRebasePath(input, retired))) !== plan.rebaseDocumentFingerprint)
            fail("retired rebase evidence changed");
    }
    if (present(rebasePath))
        fail("unexpected rebase recovery remains");
    if (input.faultAt === "after_abort")
        fail("injected shared native fault after abort");
    assertTransition();
    if (present(finalPath)) {
        if (!read(finalPath).equals(finalBytes))
            fail("conflicting shared native registration");
    }
    else
        publish(finalPath, finalBytes);
    if (input.faultAt === "after_publication")
        fail("injected shared native fault after publication");
    assertTransition();
    const archive = (0, node_path_1.join)(input.stateRoot, `shared-native-mode-transition-completed-${transitionFingerprint.slice(7)}.v1.json`);
    if (present(archive)) {
        if (hash(read(archive)) !== transitionFingerprint)
            fail("conflicting transition archive");
    }
    else {
        (0, node_fs_1.linkSync)(transitionPath, archive);
        sync(input.stateRoot);
    }
    assertTransition();
    (0, node_fs_1.unlinkSync)(transitionPath);
    sync(input.stateRoot);
    const result = readSharedNativeModeV1(input);
    if (result.state !== "ready" || result.fingerprint !== hash(finalBytes))
        return fail("published shared native registration failed readback");
    return { state: "published", document: result.document, fingerprint: result.fingerprint };
}
function publishSharedNativeModeV1(input) {
    try {
        contextSafe(input);
        noAccountRecovery(input);
        const plan = parsePlan(input.plan, input);
        if (fingerprint(plan) !== input.expectedPlanFingerprint)
            fail("shared native plan changed");
        const transitionPath = (0, node_path_1.join)(input.stateRoot, exports.SHARED_NATIVE_MODE_TRANSITION_FILE_V1);
        if (present(transitionPath))
            fail("shared native transition requires explicit recovery");
        if (present((0, node_path_1.join)(input.stateRoot, exports.SHARED_NATIVE_MODE_FILE_V1))) {
            const current = readSharedNativeModeV1(input);
            if (current.state === "ready" && current.fingerprint === fingerprint(plan.document))
                return { state: "published", document: current.document, fingerprint: current.fingerprint };
            fail("shared native registration already exists");
        }
        priorGlobals(input, plan.document);
        publish(transitionPath, bytes(plan));
        if (input.faultAt === "after_intent")
            fail("injected shared native fault after intent");
        return finish(input, plan, input.expectedPlanFingerprint);
    }
    catch (error) {
        return blocked(error);
    }
}
function recoverSharedNativeModeV1(input) {
    try {
        contextSafe(input);
        noAccountRecovery(input);
        if (!sha(input.expectedTransitionFingerprint))
            fail("invalid expected transition fingerprint");
        const path = (0, node_path_1.join)(input.stateRoot, exports.SHARED_NATIVE_MODE_TRANSITION_FILE_V1);
        if (!present(path)) {
            const archive = (0, node_path_1.join)(input.stateRoot, `shared-native-mode-transition-completed-${input.expectedTransitionFingerprint.slice(7)}.v1.json`);
            const content = read(archive);
            if (hash(content) !== input.expectedTransitionFingerprint)
                fail("completed transition evidence changed");
            const plan = parsePlan(JSON.parse(content.toString("utf8")), input);
            const current = readSharedNativeModeV1(input);
            if (current.state !== "ready" || current.fingerprint !== fingerprint(plan.document))
                return fail("completed transition registration changed");
            return { state: "published", document: current.document, fingerprint: current.fingerprint };
        }
        const content = read(path);
        if (hash(content) !== input.expectedTransitionFingerprint)
            fail("shared native recovery transaction changed");
        return finish(input, parsePlan(JSON.parse(content.toString("utf8")), input), input.expectedTransitionFingerprint);
    }
    catch (error) {
        return blocked(error);
    }
}
function parseResolverTransition(value, context) {
    if (!(0, types_1.isPlainRecord)(value) || !exact(value, ["version", "kind", "binding", "priorDocumentBytes", "priorFingerprint", "document", "signature"])
        || value.version !== 1 || value.kind !== "account-router-shared-native-resolver-transition" || !sha(value.priorFingerprint)
        || typeof value.priorDocumentBytes !== "string" || hash(value.priorDocumentBytes) !== value.priorFingerprint
        || !(0, types_1.isPlainRecord)(value.binding) || !exact(value.binding, ["operationId", "promotionId", "journalSha256", "priorRepairFingerprint", "appFingerprintSha256", "runtimeFingerprintSha256"]))
        return fail("invalid shared native resolver transition");
    verify(value, context.secret, "shared-native-resolver-transition:v1");
    const binding = value.binding;
    for (const id of [binding.operationId, binding.promotionId])
        if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
            fail("invalid resolver repair identity");
    for (const digest of [binding.journalSha256, binding.appFingerprintSha256, binding.runtimeFingerprintSha256,
        ...(binding.priorRepairFingerprint === null ? [] : [binding.priorRepairFingerprint])]) {
        if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
            fail("invalid resolver repair fingerprint");
    }
    const prior = parseDocument(JSON.parse(value.priorDocumentBytes), context);
    const next = parseDocument(value.document, context);
    const { signature: _oldSignature, resolverBinarySha256: _oldResolver, ...oldFields } = prior;
    const { signature: _newSignature, resolverBinarySha256: _newResolver, ...newFields } = next;
    if (canonical(oldFields) !== canonical(newFields) || prior.resolverBinarySha256 === next.resolverBinarySha256)
        fail("resolver transition must change only the resolver binary");
    return value;
}
/** Prepare a signed resolver-only CAS without changing the installed registration. */
function prepareSharedNativeResolverTransitionV1(input) {
    try {
        const current = readSharedNativeModeV1(input);
        if (current.state !== "ready" || current.fingerprint !== input.expectedRegistrationFingerprint)
            return fail("shared native resolver registration changed");
        const priorDocumentBytes = read((0, node_path_1.join)(input.stateRoot, exports.SHARED_NATIVE_MODE_FILE_V1)).toString("utf8");
        if (hash(priorDocumentBytes) !== current.fingerprint)
            fail("shared native resolver registration drift");
        const { signature: _signature, ...prior } = current.document;
        const document = signed({ ...prior, resolverBinarySha256: input.resolverBinarySha256 }, input.secret, "shared-native-mode:v1");
        const plan = signed({ version: 1, kind: "account-router-shared-native-resolver-transition",
            binding: input.repairBinding, priorDocumentBytes, priorFingerprint: current.fingerprint, document }, input.secret, "shared-native-resolver-transition:v1");
        parseResolverTransition(plan, input);
        return { state: "prepared", plan, fingerprint: fingerprint(plan) };
    }
    catch (error) {
        return blocked(error);
    }
}
/**
 * Explicit phases let the installer keep launch blocked until app, runtime,
 * journal and readiness challenge have all reached the same generation.
 */
function executeSharedNativeResolverTransitionV1(input) {
    try {
        contextSafe(input);
        noAccountRecovery(input);
        const plan = parseResolverTransition(input.plan, input);
        if (fingerprint(plan) !== input.expectedPlanFingerprint)
            fail("shared native resolver plan changed");
        const modePath = (0, node_path_1.join)(input.stateRoot, exports.SHARED_NATIVE_MODE_FILE_V1);
        const transitionPath = (0, node_path_1.join)(input.stateRoot, exports.SHARED_NATIVE_MODE_TRANSITION_FILE_V1);
        const priorArchive = (0, node_path_1.join)(input.stateRoot, `shared-native-resolver-prior-${input.expectedPlanFingerprint.slice(7)}.json`);
        const completed = (0, node_path_1.join)(input.stateRoot, `shared-native-resolver-completed-${input.expectedPlanFingerprint.slice(7)}.json`);
        const finalBytes = bytes(plan.document);
        const currentBytes = read(modePath);
        const prior = parseDocument(JSON.parse(plan.priorDocumentBytes), input);
        if (hash(currentBytes) !== plan.priorFingerprint && !currentBytes.equals(finalBytes))
            fail("shared native resolver CAS mismatch");
        if (present(transitionPath) && hash(read(transitionPath)) !== input.expectedPlanFingerprint)
            fail("another shared native transition owns publication");
        if (present(completed) && hash(read(completed)) !== input.expectedPlanFingerprint)
            fail("shared native completed resolver intent changed");
        const result = (state) => ({ state, binding: plan.binding,
            priorFingerprint: plan.priorFingerprint, fingerprint: hash(finalBytes),
            priorResolverBinarySha256: prior.resolverBinarySha256, resolverBinarySha256: plan.document.resolverBinarySha256 });
        if (input.action === "validate")
            return result("validated");
        if (present(completed) && !present(transitionPath)) {
            if (!currentBytes.equals(finalBytes) || !read(priorArchive).equals(Buffer.from(plan.priorDocumentBytes)))
                fail("completed resolver transition changed");
            return result(input.action === "begin" ? "begun" : input.action === "publish" ? "published" : "finished");
        }
        if (input.action === "begin") {
            if (!present(transitionPath))
                publish(transitionPath, bytes(plan));
            return result("begun");
        }
        if (!present(transitionPath))
            fail("resolver transition has not acquired its launch blocker");
        if (input.action === "publish") {
            if (present(priorArchive)) {
                if (!read(priorArchive).equals(Buffer.from(plan.priorDocumentBytes)))
                    fail("retained resolver registration changed");
            }
            else
                publish(priorArchive, Buffer.from(plan.priorDocumentBytes));
            if (!currentBytes.equals(finalBytes)) {
                const temp = (0, node_path_1.join)(input.stateRoot, `.shared-native-resolver-${(0, node_crypto_1.randomBytes)(16).toString("hex")}`);
                (0, node_fs_1.writeFileSync)(temp, finalBytes, { mode: 0o600, flag: "wx" });
                try {
                    sync(temp);
                    if (hash(read(modePath)) !== plan.priorFingerprint || hash(read(transitionPath)) !== input.expectedPlanFingerprint)
                        fail("resolver CAS changed before publication");
                    (0, node_fs_1.renameSync)(temp, modePath);
                    sync(input.stateRoot);
                }
                finally {
                    if (present(temp)) {
                        (0, node_fs_1.unlinkSync)(temp);
                        sync(input.stateRoot);
                    }
                }
            }
            return result("published");
        }
        if (input.action !== "finish")
            fail("unknown resolver transition action");
        if (!read(modePath).equals(finalBytes) || !read(priorArchive).equals(Buffer.from(plan.priorDocumentBytes)))
            fail("resolver publication is incomplete");
        if (!present(completed)) {
            (0, node_fs_1.linkSync)(transitionPath, completed);
            sync(input.stateRoot);
        }
        if (hash(read(transitionPath)) !== input.expectedPlanFingerprint)
            fail("resolver transition changed before completion");
        (0, node_fs_1.unlinkSync)(transitionPath);
        sync(input.stateRoot);
        return result("finished");
    }
    catch (error) {
        return blocked(error);
    }
}
/** Installer port: load only the exact signed native binding and wipe the key after each phase. */
function executeSharedNativeResolverTransitionAtRootV1(input) {
    let secret;
    try {
        directory(input.stateRoot);
        secret = read((0, node_path_1.join)(input.stateRoot, "control-secret.v1"));
        if (secret.length !== 32)
            fail("invalid shared native resolver signing key");
        const config = JSON.parse(read((0, node_path_1.join)(input.stateRoot, "account-router-config.json")).toString("utf8"));
        const native = (0, native_history_1.readAndPreflightNativeHistorySourceStaticV1)(input.stateRoot, config, secret);
        if (native.state !== "ready")
            return fail("shared native resolver source binding unavailable");
        return executeSharedNativeResolverTransitionV1({ ...input, secret, binding: native.binding });
    }
    catch (error) {
        return blocked(error);
    }
    finally {
        secret?.fill(0);
    }
}
//# sourceMappingURL=shared-native-mode.js.map
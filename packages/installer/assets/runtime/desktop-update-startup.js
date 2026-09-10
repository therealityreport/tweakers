"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishIndependentTweakersRuntimeReadyReceipt = publishIndependentTweakersRuntimeReadyReceipt;
exports.desktopUpdateStartupEnabled = desktopUpdateStartupEnabled;
exports.fingerprintTweakersVariantGeneration = fingerprintTweakersVariantGeneration;
exports.assertTweakersVariantBootstrap = assertTweakersVariantBootstrap;
exports.createDesktopUpdateStartupReconciler = createDesktopUpdateStartupReconciler;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * Publish the runtime half of the manager-owned readiness challenge.
 *
 * The expectation deliberately remains in place after this atomic write. The
 * manager authenticates both files and is the sole owner allowed to remove the
 * expectation after accepting the receipt.
 */
function publishIndependentTweakersRuntimeReadyReceipt(receiptPath, receipt, pid = process.pid) {
    const temporary = `${receiptPath}.${pid}.tmp`;
    (0, node_fs_1.writeFileSync)(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    (0, node_fs_1.renameSync)(temporary, receiptPath);
}
function desktopUpdateStartupEnabled(environment = process.env, identity = {}) {
    if (environment.TWEAKERS_DERIVED_VARIANT === "1")
        return false;
    if (identity.bundleIdentifier === "com.therealityreport.tweakers")
        return false;
    const appPath = identity.appPath ? (0, node_path_1.resolve)(identity.appPath) : null;
    const verified = identity.verifiedDerivedAppPath ? (0, node_path_1.resolve)(identity.verifiedDerivedAppPath) : null;
    if (appPath && verified && appPath === verified)
        return false;
    return appPath ? (0, node_path_1.basename)(appPath) !== "Tweakers.app" : true;
}
const LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION = 2;
const VARIANT_PROMOTION_JOURNAL_VERSION = 3;
const VARIANT_PROMOTION_NAMES = ["runtime", "tweaks", "state.json", "config.json", "app"];
const VARIANT_IMMUTABLE_PROMOTION_NAMES = ["runtime", "tweaks", "state.json", "app"];
const nodeVariantFilesystem = {
    existsSync: node_fs_1.existsSync,
    lstatSync: node_fs_1.lstatSync,
    readFileSync: node_fs_1.readFileSync,
    readdirSync: node_fs_1.readdirSync,
    readlinkSync: node_fs_1.readlinkSync,
};
function permissionBits(stat) {
    return Number(stat.mode) & 0o777;
}
function isCanonicalAbsolutePath(path) {
    return (0, node_path_1.isAbsolute)(path) && (0, node_path_1.resolve)(path) === path;
}
function assertVariantPromotionId(id) {
    if (typeof id !== "string"
        || id === "active"
        || id === "."
        || id === ".."
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
        || (0, node_path_1.basename)(id) !== id) {
        throw new Error("Derived variant bootstrap found an invalid promotion transaction ID.");
    }
}
function assertPrivateDirectory(path, label) {
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Derived variant bootstrap requires a non-symlink ${label}.`);
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && stat.uid !== currentUid) {
        throw new Error(`Derived variant bootstrap requires a current-user-owned ${label}.`);
    }
    if ((permissionBits(stat) & 0o077) !== 0) {
        throw new Error(`Derived variant bootstrap requires a private ${label}.`);
    }
}
function assertPrivateRegularFile(path, label) {
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Derived variant bootstrap requires a regular non-symlink ${label}.`);
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && stat.uid !== currentUid) {
        throw new Error(`Derived variant bootstrap requires a current-user-owned ${label}.`);
    }
    if ((permissionBits(stat) & 0o077) !== 0) {
        throw new Error(`Derived variant bootstrap requires a private ${label}.`);
    }
}
function assertNoSymlinkPathWithin(root, path, label) {
    const suffix = (0, node_path_1.relative)((0, node_path_1.resolve)(root), (0, node_path_1.resolve)(path));
    if (suffix === "")
        return;
    if (suffix === ".." || suffix.startsWith("../") || (0, node_path_1.isAbsolute)(suffix)) {
        throw new Error(`Derived variant bootstrap found a ${label} outside its owner-private root.`);
    }
    let current = (0, node_path_1.resolve)(root);
    for (const segment of suffix.split("/")) {
        current = (0, node_path_1.join)(current, segment);
        const stat = (0, node_fs_1.lstatSync)(current);
        if (stat.isSymbolicLink()) {
            throw new Error(`Derived variant bootstrap found a symlinked ${label} path component.`);
        }
        if (current !== (0, node_path_1.resolve)(path) && !stat.isDirectory()) {
            throw new Error(`Derived variant bootstrap found a non-directory ${label} path component.`);
        }
    }
}
function assertExactObjectKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
        throw new Error(`Derived variant bootstrap found an invalid ${label} schema.`);
    }
}
function parseFingerprint(value, label) {
    assertExactObjectKeys(value, ["kind", "mode", "sha256"], label);
    if ((value.kind !== "file" && value.kind !== "directory")
        || typeof value.mode !== "number"
        || !Number.isInteger(value.mode)
        || value.mode < 0
        || value.mode > 0o777
        || typeof value.sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(value.sha256)) {
        throw new Error(`Derived variant bootstrap found an invalid ${label}.`);
    }
    return {
        kind: value.kind,
        mode: value.mode,
        sha256: value.sha256,
    };
}
function fingerprintsMatch(left, right) {
    return left.kind === right.kind && left.mode === right.mode && left.sha256 === right.sha256;
}
/** Mirrors the installer's immutable-generation digest without importing installer code at runtime. */
function fingerprintTweakersVariantGeneration(path, fileSystem = nodeVariantFilesystem) {
    if (!fileSystem.existsSync(path))
        throw new Error(`Derived variant bootstrap generation is missing: ${path}`);
    const root = fileSystem.lstatSync(path);
    if (root.isSymbolicLink())
        throw new Error(`Derived variant bootstrap generation root is a symlink: ${path}`);
    const kind = root.isFile() ? "file" : root.isDirectory() ? "directory" : (() => {
        throw new Error(`Derived variant bootstrap generation root has an unsupported type: ${path}`);
    })();
    const hash = (0, node_crypto_1.createHash)("sha256");
    hash.update("tweakers-variant-generation-v2\0");
    const visit = (entryPath, name) => {
        const stat = fileSystem.lstatSync(entryPath);
        const mode = permissionBits(stat);
        hash.update(name).update("\0").update(String(mode)).update("\0");
        if (stat.isDirectory()) {
            hash.update("directory\0");
            for (const entry of fileSystem.readdirSync(entryPath, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
                visit((0, node_path_1.join)(entryPath, entry.name), name ? `${name}/${entry.name}` : entry.name);
            }
            return;
        }
        if (stat.isFile()) {
            hash.update("file\0").update(fileSystem.readFileSync(entryPath));
            return;
        }
        if (stat.isSymbolicLink()) {
            hash.update("symlink\0").update(fileSystem.readlinkSync(entryPath));
            return;
        }
        throw new Error(`Derived variant bootstrap generation contains an unsupported entry: ${entryPath}`);
    };
    visit(path, "");
    return { kind, mode: permissionBits(root), sha256: hash.digest("hex") };
}
function expectedPromotionEntries(userRoot, target, id) {
    const buildRoot = (0, node_path_1.join)(userRoot, "builds", id);
    const archiveRoot = (0, node_path_1.join)(userRoot, "previous", id);
    const failedRoot = (0, node_path_1.join)(buildRoot, "failed-promotion");
    return [
        {
            name: "runtime",
            source: (0, node_path_1.join)(buildRoot, "runtime"),
            destination: (0, node_path_1.join)(userRoot, "runtime"),
            archive: (0, node_path_1.join)(archiveRoot, "state", "runtime"),
            failed: (0, node_path_1.join)(failedRoot, "state", "runtime"),
        },
        {
            name: "tweaks",
            source: (0, node_path_1.join)(buildRoot, "tweaks"),
            destination: (0, node_path_1.join)(userRoot, "tweaks"),
            archive: (0, node_path_1.join)(archiveRoot, "state", "tweaks"),
            failed: (0, node_path_1.join)(failedRoot, "state", "tweaks"),
        },
        {
            name: "state.json",
            source: (0, node_path_1.join)(buildRoot, "state.json"),
            destination: (0, node_path_1.join)(userRoot, "state.json"),
            archive: (0, node_path_1.join)(archiveRoot, "state", "state.json"),
            failed: (0, node_path_1.join)(failedRoot, "state", "state.json"),
        },
        {
            name: "config.json",
            source: (0, node_path_1.join)(buildRoot, "config.json"),
            destination: (0, node_path_1.join)(userRoot, "config.json"),
            archive: (0, node_path_1.join)(archiveRoot, "state", "config.json"),
            failed: (0, node_path_1.join)(failedRoot, "state", "config.json"),
        },
        {
            name: "app",
            source: (0, node_path_1.join)((0, node_path_1.dirname)(target), `.${(0, node_path_1.basename)(target)}.candidate-${id}.app`),
            destination: target,
            archive: (0, node_path_1.join)(archiveRoot, "app", (0, node_path_1.basename)(target)),
            failed: (0, node_path_1.join)(failedRoot, "app", (0, node_path_1.basename)(target)),
        },
    ];
}
function expectedActiveReceiptPaths(userRoot, id) {
    const buildRoot = (0, node_path_1.join)(userRoot, "builds", id);
    return {
        source: (0, node_path_1.join)(buildRoot, "active-receipt.json"),
        destination: (0, node_path_1.join)(userRoot, "transactions", "variant-promotion", "active.json"),
        archive: (0, node_path_1.join)(userRoot, "previous", id, "active-receipt.json"),
        failed: (0, node_path_1.join)(buildRoot, "failed-promotion", "active-receipt.json"),
    };
}
function knownPromotionPhase(phase) {
    if (["prepared", "promoting", "active:archive-planned", "active:archived", "active:promote-planned", "active:promoted", "committed", "recovered"].includes(phase)) {
        return true;
    }
    return VARIANT_PROMOTION_NAMES.some((name) => (phase === `${name}:archive-planned`
        || phase === `${name}:archived`
        || phase === `${name}:promote-planned`
        || phase === `${name}:promoted`));
}
function parseActiveReceipt(value, expected) {
    assertExactObjectKeys(value, ["version", "id", "userRoot", "target", "entries"], "active receipt");
    if (value.version !== expected.version
        || value.id !== expected.id
        || value.userRoot !== expected.userRoot
        || value.target !== expected.target
        || !Array.isArray(value.entries)
        || value.entries.length !== expected.entries.length) {
        throw new Error("Derived variant bootstrap active receipt does not match its exact generation binding.");
    }
    const entries = value.entries.map((entry, index) => {
        const wanted = expected.entries[index];
        assertExactObjectKeys(entry, ["name", "path", "fingerprint"], "active receipt generation");
        if (entry.name !== wanted.name || entry.path !== wanted.path) {
            throw new Error("Derived variant bootstrap active receipt has an unexpected generation path.");
        }
        const fingerprint = parseFingerprint(entry.fingerprint, "active receipt generation fingerprint");
        if (!fingerprintsMatch(fingerprint, wanted.fingerprint)) {
            throw new Error("Derived variant bootstrap active receipt has a mismatched generation fingerprint.");
        }
        return { name: wanted.name, path: wanted.path, fingerprint };
    });
    return {
        version: expected.version,
        id: expected.id,
        userRoot: expected.userRoot,
        target: expected.target,
        entries,
    };
}
function parseJournal(value, userRoot, target) {
    assertExactObjectKeys(value, [
        "version", "id", "userRoot", "target", "candidate", "buildRoot", "phase", "entries", "activeReceipt",
    ], "promotion journal");
    if ((value.version !== VARIANT_PROMOTION_JOURNAL_VERSION
        && value.version !== LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION)
        || typeof value.id !== "string"
        || typeof value.userRoot !== "string"
        || typeof value.target !== "string"
        || typeof value.candidate !== "string"
        || typeof value.buildRoot !== "string"
        || typeof value.phase !== "string"
        || !Array.isArray(value.entries)) {
        throw new Error("Derived variant bootstrap found an unsupported promotion journal.");
    }
    assertVariantPromotionId(value.id);
    if (value.userRoot !== userRoot
        || value.target !== target
        || !isCanonicalAbsolutePath(value.userRoot)
        || !isCanonicalAbsolutePath(value.target)
        || !isCanonicalAbsolutePath(value.candidate)
        || !isCanonicalAbsolutePath(value.buildRoot)
        || value.buildRoot !== (0, node_path_1.join)(userRoot, "builds", value.id)
        || value.candidate !== (0, node_path_1.join)((0, node_path_1.dirname)(target), `.${(0, node_path_1.basename)(target)}.candidate-${value.id}.app`)
        || !knownPromotionPhase(value.phase)) {
        throw new Error("Derived variant bootstrap journal path binding is invalid.");
    }
    const expectedEntries = expectedPromotionEntries(userRoot, target, value.id);
    if (value.entries.length !== expectedEntries.length) {
        throw new Error("Derived variant bootstrap journal generation count is invalid.");
    }
    const entries = value.entries.map((entry, index) => {
        const wanted = expectedEntries[index];
        assertExactObjectKeys(entry, ["name", "source", "destination", "archive", "failed", "hadDestination", "desired", "previous"], "promotion journal generation");
        if (entry.name !== wanted.name
            || entry.source !== wanted.source
            || entry.destination !== wanted.destination
            || entry.archive !== wanted.archive
            || entry.failed !== wanted.failed
            || typeof entry.hadDestination !== "boolean") {
            throw new Error("Derived variant bootstrap journal generation path is invalid.");
        }
        const desired = parseFingerprint(entry.desired, "promotion journal desired fingerprint");
        const previous = entry.previous === null ? null : parseFingerprint(entry.previous, "promotion journal prior fingerprint");
        if ((entry.hadDestination && previous === null) || (!entry.hadDestination && previous !== null)) {
            throw new Error("Derived variant bootstrap journal prior generation is invalid.");
        }
        return { ...wanted, hadDestination: entry.hadDestination, desired, previous };
    });
    const immutableNames = new Set(VARIANT_IMMUTABLE_PROMOTION_NAMES);
    const expectedActive = {
        version: value.version,
        id: value.id,
        userRoot,
        target,
        entries: entries
            .filter((entry) => value.version === LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION || immutableNames.has(entry.name))
            .map((entry) => ({ name: entry.name, path: entry.destination, fingerprint: entry.desired })),
    };
    assertExactObjectKeys(value.activeReceipt, [
        "source", "destination", "archive", "failed", "hadDestination", "desired", "previous", "expected",
    ], "promotion journal active receipt");
    const activePaths = expectedActiveReceiptPaths(userRoot, value.id);
    if (value.activeReceipt.source !== activePaths.source
        || value.activeReceipt.destination !== activePaths.destination
        || value.activeReceipt.archive !== activePaths.archive
        || value.activeReceipt.failed !== activePaths.failed
        || typeof value.activeReceipt.hadDestination !== "boolean") {
        throw new Error("Derived variant bootstrap journal active receipt path is invalid.");
    }
    const activeDesired = parseFingerprint(value.activeReceipt.desired, "promotion journal active receipt fingerprint");
    const activePrevious = value.activeReceipt.previous === null
        ? null
        : parseFingerprint(value.activeReceipt.previous, "promotion journal prior active receipt fingerprint");
    if ((value.activeReceipt.hadDestination && activePrevious === null)
        || (!value.activeReceipt.hadDestination && activePrevious !== null)) {
        throw new Error("Derived variant bootstrap journal prior active receipt is invalid.");
    }
    parseActiveReceipt(value.activeReceipt.expected, expectedActive);
    return {
        version: value.version,
        id: value.id,
        userRoot,
        target,
        candidate: value.candidate,
        buildRoot: value.buildRoot,
        phase: value.phase,
        entries,
        activeReceipt: {
            ...activePaths,
            hadDestination: value.activeReceipt.hadDestination,
            desired: activeDesired,
            previous: activePrevious,
            expected: expectedActive,
        },
    };
}
function parseProvisionalRuntimeReadyExpectation(value, target) {
    assertExactObjectKeys(value, [
        "schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "appRoot", "bundleId",
        "appAsarHeaderHash", "runtimeFingerprint", "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot",
        "brokerAuthorityExpectation", "appearanceExpectation", "expectedTweakIds", "createdAt",
    ], "runtime-ready expectation");
    const validId = (candidate) => typeof candidate === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate);
    const validHash = (candidate) => typeof candidate === "string"
        && /^[a-f0-9]{64}$/i.test(candidate);
    const validPath = (candidate) => typeof candidate === "string"
        && isCanonicalAbsolutePath(candidate);
    assertExactObjectKeys(value.brokerAuthorityExpectation, ["globalRootState", "configSha256"], "runtime-ready broker authority expectation");
    const brokerAuthorityExpectation = value.brokerAuthorityExpectation;
    const validBrokerAuthorityExpectation = (brokerAuthorityExpectation.globalRootState === "absent"
        && brokerAuthorityExpectation.configSha256 === null)
        || (brokerAuthorityExpectation.globalRootState === "valid-v3"
            && typeof brokerAuthorityExpectation.configSha256 === "string"
            && /^[a-f0-9]{64}$/i.test(brokerAuthorityExpectation.configSha256));
    assertExactObjectKeys(value.appearanceExpectation, ["status", "normalized"], "runtime-ready appearance expectation");
    const appearanceExpectation = value.appearanceExpectation;
    const validAppearanceExpectation = appearanceExpectation.status === "normal"
        && appearanceExpectation.normalized === true;
    if (value.schemaVersion !== 5
        || value.kind !== "tweakers-independent-runtime-ready-expectation"
        || !validId(value.operationId)
        || !validId(value.promotionId)
        || !validHash(value.activePromotionReceiptSha256)
        || value.appRoot !== target
        || value.bundleId !== "com.therealityreport.tweakers"
        || !validHash(value.appAsarHeaderHash)
        || !validHash(value.runtimeFingerprint)
        || !validPath(value.appUserDataRoot)
        || !validPath(value.codexHomeRoot)
        || !validPath(value.accountsBrokerRoot)
        || !validBrokerAuthorityExpectation
        || !validAppearanceExpectation
        || !Array.isArray(value.expectedTweakIds)
        || value.expectedTweakIds.length === 0
        || value.expectedTweakIds.length > 128
        || new Set(value.expectedTweakIds).size !== value.expectedTweakIds.length
        || !value.expectedTweakIds.every((id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(id))
        || typeof value.createdAt !== "string"
        || Number.isNaN(Date.parse(value.createdAt))) {
        throw new Error("Derived variant bootstrap found an invalid runtime-ready expectation.");
    }
    return value;
}
function assertProvisionalPendingGeneration(journal, activePath, userRoot, target, fileSystem) {
    if (journal.phase !== "app:promoted") {
        throw new Error(`Derived variant bootstrap refuses pending promotion journal ${journal.id}.`);
    }
    const expectationPath = (0, node_path_1.join)(userRoot, "runtime-ready-expectation.json");
    if (!(0, node_fs_1.existsSync)(expectationPath)) {
        throw new Error(`Derived variant bootstrap refuses pending promotion journal ${journal.id}.`);
    }
    assertNoSymlinkPathWithin(userRoot, expectationPath, "runtime-ready expectation");
    assertPrivateRegularFile(expectationPath, "derived variant runtime-ready expectation");
    let rawExpectation;
    try {
        rawExpectation = JSON.parse((0, node_fs_1.readFileSync)(expectationPath, "utf8"));
    }
    catch {
        throw new Error("Derived variant bootstrap runtime-ready expectation is corrupt.");
    }
    const expectation = parseProvisionalRuntimeReadyExpectation(rawExpectation, target);
    if (expectation.promotionId !== journal.id) {
        throw new Error("Derived variant bootstrap runtime-ready expectation does not bind the pending promotion.");
    }
    assertPrivateRegularFile(journal.activeReceipt.source, "derived variant staged active receipt");
    let stagedActiveRaw;
    try {
        stagedActiveRaw = JSON.parse((0, node_fs_1.readFileSync)(journal.activeReceipt.source, "utf8"));
    }
    catch {
        throw new Error("Derived variant bootstrap staged active receipt is corrupt.");
    }
    parseActiveReceipt(stagedActiveRaw, journal.activeReceipt.expected);
    const stagedActiveFingerprint = fingerprintTweakersVariantGeneration(journal.activeReceipt.source, fileSystem);
    if (!fingerprintsMatch(stagedActiveFingerprint, journal.activeReceipt.desired)
        || stagedActiveFingerprint.sha256 !== expectation.activePromotionReceiptSha256) {
        throw new Error("Derived variant bootstrap runtime-ready expectation does not bind the staged active receipt.");
    }
    if (journal.activeReceipt.hadDestination) {
        if (activePath === null || journal.activeReceipt.previous === null) {
            throw new Error("Derived variant bootstrap pending promotion lost its prior active receipt.");
        }
        const priorActiveFingerprint = fingerprintTweakersVariantGeneration(activePath, fileSystem);
        if (!fingerprintsMatch(priorActiveFingerprint, journal.activeReceipt.previous)) {
            throw new Error("Derived variant bootstrap pending promotion prior receipt changed.");
        }
    }
    else if (activePath !== null) {
        throw new Error("Derived variant bootstrap pending first promotion found an unexpected active receipt.");
    }
    for (const entry of journal.entries) {
        const actual = fingerprintTweakersVariantGeneration(entry.destination, fileSystem);
        if (!fingerprintsMatch(actual, entry.desired)) {
            throw new Error(`Derived variant bootstrap pending generation fingerprint mismatch: ${entry.name}`);
        }
    }
}
/**
 * Refuse a derived app before any tweak or app-server startup if its active
 * generation is not exactly committed and immutable. The broker calls this
 * after it has established the loader-provided user-root/runtime environment.
 */
function assertTweakersVariantBootstrap(options = {}) {
    const environment = options.environment ?? process.env;
    if (environment.TWEAKERS_DERIVED_VARIANT !== "1")
        return;
    const fileSystem = options.fileSystem ?? nodeVariantFilesystem;
    const userRoot = environment.TWEAKERS_USER_ROOT ?? environment.TWEAKER_USER_ROOT;
    const runtime = environment.TWEAKERS_RUNTIME ?? environment.TWEAKER_RUNTIME;
    const resourcesPath = options.resourcesPath ?? process.resourcesPath;
    if (!userRoot || !runtime || !resourcesPath
        || !isCanonicalAbsolutePath(userRoot)
        || !isCanonicalAbsolutePath(runtime)
        || !isCanonicalAbsolutePath(resourcesPath)) {
        throw new Error("Derived variant bootstrap is missing exact loader path bindings.");
    }
    const target = (0, node_path_1.dirname)((0, node_path_1.dirname)(resourcesPath));
    if (runtime !== (0, node_path_1.join)(userRoot, "runtime") || !isCanonicalAbsolutePath(target)) {
        throw new Error("Derived variant bootstrap runtime binding does not match its user root.");
    }
    assertPrivateDirectory(userRoot, "derived variant user root");
    const journalRoot = (0, node_path_1.join)(userRoot, "transactions", "variant-promotion");
    assertNoSymlinkPathWithin(userRoot, journalRoot, "promotion journal");
    assertPrivateDirectory(journalRoot, "derived variant promotion journal root");
    const journals = new Map();
    let activePath = null;
    for (const entry of (0, node_fs_1.readdirSync)(journalRoot, { withFileTypes: true })) {
        const path = (0, node_path_1.join)(journalRoot, entry.name);
        if (entry.name === "active.json") {
            assertPrivateRegularFile(path, "derived variant active receipt");
            activePath = path;
            continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json") || entry.name === "active.json") {
            throw new Error(`Derived variant bootstrap found an unexpected promotion journal entry: ${entry.name}`);
        }
        const id = entry.name.slice(0, -".json".length);
        assertVariantPromotionId(id);
        assertPrivateRegularFile(path, "derived variant promotion journal");
        let raw;
        try {
            raw = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
        }
        catch {
            throw new Error(`Derived variant bootstrap found a corrupt promotion journal: ${entry.name}`);
        }
        const journal = parseJournal(raw, userRoot, target);
        if (journal.id !== id)
            throw new Error("Derived variant bootstrap journal filename does not match its transaction ID.");
        journals.set(journal.id, journal);
    }
    const pending = [...journals.values()].filter((journal) => journal.phase !== "committed" && journal.phase !== "recovered");
    if (pending.length > 0) {
        if (pending.length !== 1) {
            throw new Error("Derived variant bootstrap refuses multiple pending promotion journals.");
        }
        assertProvisionalPendingGeneration(pending[0], activePath, userRoot, target, fileSystem);
        return;
    }
    if (activePath === null)
        throw new Error("Derived variant bootstrap has no committed active generation receipt.");
    let activeRaw;
    try {
        activeRaw = JSON.parse((0, node_fs_1.readFileSync)(activePath, "utf8"));
    }
    catch {
        throw new Error("Derived variant bootstrap active generation receipt is corrupt.");
    }
    assertExactObjectKeys(activeRaw, ["version", "id", "userRoot", "target", "entries"], "active receipt");
    const activeId = activeRaw.id;
    assertVariantPromotionId(activeId);
    const journal = journals.get(activeId);
    if (!journal || journal.phase !== "committed") {
        throw new Error("Derived variant bootstrap active receipt has no matching committed journal.");
    }
    const active = parseActiveReceipt(activeRaw, journal.activeReceipt.expected);
    const activeReceiptFingerprint = fingerprintTweakersVariantGeneration(activePath, fileSystem);
    if (!fingerprintsMatch(activeReceiptFingerprint, journal.activeReceipt.desired)) {
        throw new Error("Derived variant bootstrap active receipt fingerprint does not match its committed journal.");
    }
    for (const entry of active.entries) {
        // v2 receipts included mutable user preferences. Continue accepting an
        // already-committed v2 transaction, but never treat its config fingerprint
        // as an immutable startup gate. New v3 receipts omit config entirely.
        if (entry.name === "config.json")
            continue;
        const actual = fingerprintTweakersVariantGeneration(entry.path, fileSystem);
        if (!fingerprintsMatch(actual, entry.fingerprint)) {
            throw new Error(`Derived variant bootstrap generation fingerprint mismatch: ${entry.name}`);
        }
    }
}
/**
 * Schedule one bounded startup reconciliation after Electron is ready. A
 * missing visible window or launcher failure is diagnostic evidence only; it
 * must never abort the desktop app's module initialization.
 */
function createDesktopUpdateStartupReconciler(dependencies, options = {}) {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 30));
    const retryMs = Math.max(0, Math.floor(options.retryMs ?? 1_000));
    let scheduled = false;
    const attempt = (attempts) => {
        let ready = false;
        try {
            ready = dependencies.windowReady();
        }
        catch (error) {
            dependencies.onEvent({
                event: "desktop-update-startup-reconcile",
                result: "failed",
                attempts,
                ...errorEvidence(error),
            });
            return;
        }
        if (!ready) {
            if (attempts >= maxAttempts) {
                dependencies.onEvent({
                    event: "desktop-update-startup-reconcile",
                    result: "window-unavailable",
                    attempts,
                });
                return;
            }
            dependencies.setTimer(() => attempt(attempts + 1), retryMs);
            return;
        }
        try {
            dependencies.launch();
            dependencies.onEvent({
                event: "desktop-update-startup-reconcile",
                result: "submitted",
                attempts,
            });
        }
        catch (error) {
            dependencies.onEvent({
                event: "desktop-update-startup-reconcile",
                result: "failed",
                attempts,
                ...errorEvidence(error),
            });
        }
    };
    return {
        schedule() {
            if (scheduled)
                return false;
            scheduled = true;
            dependencies.setTimer(() => attempt(1), 0);
            return true;
        },
    };
}
function errorEvidence(error) {
    const record = error && typeof error === "object"
        ? error
        : null;
    return {
        error: typeof record?.message === "string" ? record.message : String(error),
        ...(typeof record?.code === "string" ? { errorCode: record.code } : {}),
    };
}
//# sourceMappingURL=desktop-update-startup.js.map
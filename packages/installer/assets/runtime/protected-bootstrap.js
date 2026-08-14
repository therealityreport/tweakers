"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.APPLIED_PENDING_LAUNCH_GRANT_SCHEMA_VERSION = exports.PROTECTED_BOOTSTRAP_SCHEMA_VERSION = void 0;
exports.armProtectedUpdateQuarantine = armProtectedUpdateQuarantine;
exports.assertProtectedUpdateQuarantine = assertProtectedUpdateQuarantine;
exports.assertProtectedUpdateQuarantineMarker = assertProtectedUpdateQuarantineMarker;
exports.createAppliedPendingLaunchGrant = createAppliedPendingLaunchGrant;
exports.runProtectedBootstrapPreflight = runProtectedBootstrapPreflight;
exports.applyProtectedBootstrapEnvironment = applyProtectedBootstrapEnvironment;
exports.createProtectedBootstrapPreflightReceipt = createProtectedBootstrapPreflightReceipt;
exports.isProtectedBootstrapPreflightReceipt = isProtectedBootstrapPreflightReceipt;
exports.preflightReceiptSha256 = preflightReceiptSha256;
exports.protectedLaunchIdentitySha256 = protectedLaunchIdentitySha256;
exports.isAppliedPendingLaunchGrantV1 = isAppliedPendingLaunchGrantV1;
exports.isProtectedEnvironmentState = isProtectedEnvironmentState;
exports.isProtectedLaunchIdentity = isProtectedLaunchIdentity;
exports.assertProtectedEnvironmentState = assertProtectedEnvironmentState;
exports.assertProtectedLaunchIdentity = assertProtectedLaunchIdentity;
const node_crypto_1 = require("node:crypto");
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const asar_1 = __importDefault(require("@electron/asar"));
/**
 * The protected bootstrap is intentionally independent of the Tweakers
 * renderer/runtime.  It is the only pre-main authority used by the protected
 * shell and therefore accepts immutable candidate inputs only.  In
 * particular, it must never inspect a published selection, a running
 * app-server, a terminal transaction, or an installed canary result.
 */
exports.PROTECTED_BOOTSTRAP_SCHEMA_VERSION = 1;
exports.APPLIED_PENDING_LAUNCH_GRANT_SCHEMA_VERSION = 1;
const DEFAULT_UPDATE_QUARANTINE_DEPS = {
    exists: node_fs_1.existsSync,
    list: node_fs_1.readdirSync,
    lstat: node_fs_1.lstatSync,
    read: (path) => (0, node_fs_1.readFileSync)(path, "utf8"),
};
/**
 * The protected loader is the sole arming point.  It supplies its durable
 * authority writer so this shared guard never weakens loader write semantics.
 */
function armProtectedUpdateQuarantine(input, write) {
    const marker = {
        schemaVersion: 1,
        kind: "protected-update-quarantine",
        transactionId: input.transactionId,
        attempt: input.attempt,
        preflightReceiptSha256: input.preflightReceiptSha256,
        armedAt: input.armedAt,
        normalLaunchBlockedUntilFreshAuthority: true,
    };
    assertProtectedUpdateQuarantineMarker(marker);
    write(marker);
    return marker;
}
/**
 * Fail closed whenever any protected transaction has armed its update
 * quarantine.  A new protected candidate is the only authority-producing
 * route; generic Sparkle, refresh, repair, and recovery must not silently
 * restore the bundled backend behind the protected shell.
 */
function assertProtectedUpdateQuarantine(input, dependencyOverrides = {}) {
    if (!exactAbsolutePath(input.authorityRoot)) {
        throw new Error("Protected update quarantine authority root is invalid");
    }
    if (!isNonEmptyText(input.route)) {
        throw new Error("Protected update quarantine route is invalid");
    }
    const deps = { ...DEFAULT_UPDATE_QUARANTINE_DEPS, ...dependencyOverrides };
    const protectedRoot = (0, node_path_1.join)(input.authorityRoot, "transactions", "protected");
    if (!deps.exists(protectedRoot))
        return;
    const protectedRootStatus = deps.lstat(protectedRoot);
    if (!protectedRootStatus.isDirectory() || protectedRootStatus.isSymbolicLink()) {
        throw new Error("Protected update quarantine authority directory is unsafe");
    }
    for (const entry of deps.list(protectedRoot)) {
        const quarantineFile = (0, node_path_1.join)(protectedRoot, entry, "update-quarantine.json");
        if (!deps.exists(quarantineFile))
            continue;
        const status = deps.lstat(quarantineFile);
        if (!status.isFile() || status.isSymbolicLink()) {
            throw new Error("Protected update quarantine marker is unsafe");
        }
        let marker;
        try {
            marker = JSON.parse(deps.read(quarantineFile));
        }
        catch {
            throw new Error("Protected update quarantine marker is unreadable");
        }
        assertProtectedUpdateQuarantineMarker(marker);
        throw new Error(`Protected update quarantine blocks ${input.route}; fresh protected authority is required`);
    }
}
function assertProtectedUpdateQuarantineMarker(value) {
    if (!isRecord(value)
        || value.schemaVersion !== 1
        || value.kind !== "protected-update-quarantine"
        || typeof value.transactionId !== "string"
        || typeof value.attempt !== "number"
        || typeof value.preflightReceiptSha256 !== "string"
        || typeof value.armedAt !== "string"
        || value.normalLaunchBlockedUntilFreshAuthority !== true) {
        throw new Error("Protected update quarantine marker is invalid");
    }
    assertTransactionAndAttempt(value.transactionId, value.attempt);
    assertSha256(value.preflightReceiptSha256, "Protected update quarantine receipt digest");
    assertTimestamp(value.armedAt, "Protected update quarantine armedAt");
}
const SHA256_RE = /^[a-f0-9]{64}$/i;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const FORBIDDEN_PREMAIN_KEYS = new Set([
    "terminalHealthy",
    "committed",
    "publishedSelection",
    "installedSelection",
    "activeBackend",
    "activeBackendIdentity",
    "backendPid",
    "backendKernelStart",
    "installedCanary",
    "installedModeCanary",
    "canaryReceipt",
    "windowEvidence",
    "rendererEvidence",
]);
const DEFAULT_DEPS = {
    now: () => new Date().toISOString(),
    sha256File: (path) => (0, node_crypto_1.createHash)("sha256").update((0, node_fs_1.readFileSync)(path)).digest("hex"),
    probeVersion: (path) => {
        try {
            const output = (0, node_child_process_1.execFileSync)(path, ["--version"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 5_000,
                maxBuffer: 64 * 1024,
            }).trim();
            return output.split(/\s+/).at(-1) ?? null;
        }
        catch {
            return null;
        }
    },
    probeArchitecture: (path) => {
        try {
            const output = (0, node_child_process_1.execFileSync)("/usr/bin/file", ["-b", path], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 5_000,
                maxBuffer: 64 * 1024,
            });
            return /\barm64\b/.test(output) ? "arm64" : null;
        }
        catch {
            return null;
        }
    },
    fingerprintAppContents: fingerprintProtectedAppContents,
    readAsarHeader: (path) => {
        const raw = asar_1.default.getRawHeader(path);
        return (0, node_crypto_1.createHash)("sha256").update(raw.headerString).digest("hex");
    },
    readAsarEntry: (path, entry) => Buffer.from(asar_1.default.extractFile(path, entry)),
    readSignature: (path) => {
        const result = (0, node_child_process_1.spawnSync)("codesign", ["-dv", "--verbose=4", path], {
            encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
        });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        return result.status === 0 && output ? output : null;
    },
    emit: () => undefined,
};
function createAppliedPendingLaunchGrant(input) {
    assertTransactionAndAttempt(input.transactionId, input.attempt);
    assertTimestamp(input.issuedAt, "Grant issuedAt");
    assertTimestamp(input.expiresAt, "Grant expiresAt");
    if (Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) {
        throw new Error("Launch grant expiry must be after issuance");
    }
    assertSha256(input.authoritySha256, "Launch grant authority digest");
    assertSha256(input.acceptedBuildReceiptSha256, "Accepted build receipt digest");
    assertProtectedEnvironmentState(input.environment);
    assertProtectedLaunchIdentity(input.identity);
    const nonce = input.nonce ?? (0, node_crypto_1.randomUUID)();
    if (!isNonce(nonce))
        throw new Error("Launch grant nonce is invalid");
    return {
        schemaVersion: exports.APPLIED_PENDING_LAUNCH_GRANT_SCHEMA_VERSION,
        kind: "applied-pending-launch-grant",
        transactionId: input.transactionId,
        attempt: input.attempt,
        nonce,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        authoritySha256: input.authoritySha256.toLowerCase(),
        acceptedBuildReceiptSha256: input.acceptedBuildReceiptSha256.toLowerCase(),
        environment: { ...input.environment },
        identity: { ...input.identity },
        consumedBy: null,
    };
}
/**
 * Validate and consume an exact one-use grant.  This returns a receipt for
 * every outcome so a protected loader can remain fail-closed without
 * inventing post-main proof.  A FAIL result never changes caller-owned env.
 */
function runProtectedBootstrapPreflight(input, dependencyOverrides = {}) {
    const deps = { ...DEFAULT_DEPS, ...dependencyOverrides };
    const emittedAt = input.now ?? deps.now();
    const failure = (reason, grant = null) => {
        const receipt = createProtectedBootstrapPreflightReceipt({
            schemaVersion: exports.PROTECTED_BOOTSTRAP_SCHEMA_VERSION,
            kind: "protected-bootstrap-preflight",
            transactionId: grant?.transactionId ?? input.expectedTransactionId,
            attempt: grant?.attempt ?? input.expectedAttempt,
            nonce: grant?.nonce ?? null,
            verdict: "FAIL",
            reason,
            environment: grant ? { ...grant.environment } : null,
            identitySha256: grant ? protectedLaunchIdentitySha256(grant.identity) : null,
            backend: grant ? backendSummary(grant.identity) : null,
            consumedAt: null,
            emittedAt,
        });
        deps.emit(receipt);
        return receipt;
    };
    try {
        assertTransactionAndAttempt(input.expectedTransactionId, input.expectedAttempt);
        if (!Number.isSafeInteger(input.desktop.pid) || input.desktop.pid <= 0) {
            return failure("desktop-pid-invalid");
        }
        if (!isNonEmptyText(input.desktop.kernelStart))
            return failure("desktop-kernel-start-invalid");
        if (!isRecord(input.grant))
            return failure("launch-grant-invalid");
        assertNoPostMainFields(input.grant);
        if (!isAppliedPendingLaunchGrantV1(input.grant))
            return failure("launch-grant-invalid");
        const grant = input.grant;
        if (grant.transactionId !== input.expectedTransactionId || grant.attempt !== input.expectedAttempt) {
            return failure("launch-grant-transaction-mismatch", grant);
        }
        if (Date.parse(grant.expiresAt) <= Date.parse(emittedAt)) {
            return failure("launch-grant-expired", grant);
        }
        if (grant.consumedBy !== null)
            return failure("launch-grant-already-consumed", grant);
        assertProtectedEnvironmentState(grant.environment);
        assertProtectedLaunchIdentity(grant.identity);
        assertExactBackendIdentity(grant.identity, deps);
        assertExactLaunchIdentity(grant.identity, grant.environment, deps);
        const consumedAt = emittedAt;
        const consumed = {
            ...grant,
            consumedBy: {
                desktopPid: input.desktop.pid,
                desktopKernelStart: input.desktop.kernelStart,
                consumedAt,
            },
        };
        if (deps.consumeGrant && !deps.consumeGrant(grant, consumed)) {
            return failure("launch-grant-consume-conflict", grant);
        }
        const receipt = createProtectedBootstrapPreflightReceipt({
            schemaVersion: exports.PROTECTED_BOOTSTRAP_SCHEMA_VERSION,
            kind: "protected-bootstrap-preflight",
            transactionId: grant.transactionId,
            attempt: grant.attempt,
            nonce: grant.nonce,
            verdict: "PASS",
            reason: null,
            environment: { ...grant.environment },
            identitySha256: protectedLaunchIdentitySha256(grant.identity),
            backend: backendSummary(grant.identity),
            consumedAt,
            emittedAt,
        });
        deps.emit(receipt);
        return receipt;
    }
    catch (error) {
        return failure(errorMessage(error));
    }
}
/**
 * The protected loader calls this only after a PASS receipt.  It adds an exact
 * in-bundle backend path and deliberately has no branch that clears the value
 * or selects the official bundled backend on failure.
 */
function applyProtectedBootstrapEnvironment(receipt, inherited = process.env) {
    if (!isProtectedBootstrapPreflightReceipt(receipt) || receipt.verdict !== "PASS" || receipt.backend === null) {
        throw new Error("Protected bootstrap did not pass; OpenAI main must not load");
    }
    return {
        ...inherited,
        CODEX_CLI_PATH: receipt.backend.path,
    };
}
function createProtectedBootstrapPreflightReceipt(input) {
    assertProtectedBootstrapPreflightReceiptInput(input);
    const canonical = canonicalPreflightReceiptInput(input);
    return {
        ...canonical,
        receiptSha256: preflightReceiptSha256(canonical),
    };
}
function isProtectedBootstrapPreflightReceipt(value) {
    if (!isRecord(value) || typeof value.receiptSha256 !== "string" || !SHA256_RE.test(value.receiptSha256)) {
        return false;
    }
    try {
        const { receiptSha256, ...input } = value;
        assertProtectedBootstrapPreflightReceiptInput(input);
        return receiptSha256.toLowerCase() === preflightReceiptSha256(canonicalPreflightReceiptInput(input));
    }
    catch {
        return false;
    }
}
function preflightReceiptSha256(receipt) {
    return (0, node_crypto_1.createHash)("sha256").update(JSON.stringify(sortReceiptValue(receipt))).digest("hex");
}
function assertProtectedBootstrapPreflightReceiptInput(value) {
    if (!isRecord(value)
        || value.schemaVersion !== exports.PROTECTED_BOOTSTRAP_SCHEMA_VERSION
        || value.kind !== "protected-bootstrap-preflight"
        || typeof value.transactionId !== "string"
        || typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt)
        || (value.nonce !== null && (typeof value.nonce !== "string" || !isNonce(value.nonce)))
        || (value.verdict !== "PASS" && value.verdict !== "FAIL" && value.verdict !== "INCONCLUSIVE")
        || (value.reason !== null && !isNonEmptyText(value.reason))
        || (value.environment !== null && !isProtectedEnvironmentState(value.environment))
        || (value.identitySha256 !== null && (typeof value.identitySha256 !== "string" || !SHA256_RE.test(value.identitySha256)))
        || (value.backend !== null && !isPreflightBackend(value.backend))
        || (value.consumedAt !== null && (typeof value.consumedAt !== "string" || !ISO_TIMESTAMP_RE.test(value.consumedAt)))
        || typeof value.emittedAt !== "string") {
        throw new Error("Protected bootstrap preflight receipt is invalid");
    }
    assertTransactionAndAttempt(value.transactionId, value.attempt);
    assertTimestamp(value.emittedAt, "Preflight emittedAt");
    if (value.consumedAt !== null)
        assertTimestamp(value.consumedAt, "Preflight consumedAt");
    if (value.verdict === "PASS") {
        if (value.nonce === null || value.reason !== null || value.environment === null
            || value.identitySha256 === null || value.backend === null || value.consumedAt === null) {
            throw new Error("Passing protected bootstrap preflight receipt is incomplete");
        }
    }
}
function isPreflightBackend(value) {
    return isRecord(value)
        && exactAbsolutePath(value.path)
        && typeof value.sha256 === "string"
        && SHA256_RE.test(value.sha256)
        && isNonEmptyText(value.version)
        && value.architecture === "arm64";
}
function canonicalPreflightReceiptInput(input) {
    return {
        schemaVersion: exports.PROTECTED_BOOTSTRAP_SCHEMA_VERSION,
        kind: "protected-bootstrap-preflight",
        transactionId: input.transactionId,
        attempt: input.attempt,
        nonce: input.nonce,
        verdict: input.verdict,
        reason: input.reason,
        environment: input.environment === null ? null : { ...input.environment },
        identitySha256: input.identitySha256 === null ? null : input.identitySha256.toLowerCase(),
        backend: input.backend === null ? null : {
            path: input.backend.path,
            sha256: input.backend.sha256.toLowerCase(),
            version: input.backend.version,
            architecture: "arm64",
        },
        consumedAt: input.consumedAt,
        emittedAt: input.emittedAt,
    };
}
function sortReceiptValue(value) {
    if (Array.isArray(value))
        return value.map(sortReceiptValue);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortReceiptValue(value[key])]));
}
function protectedLaunchIdentitySha256(identity) {
    assertProtectedLaunchIdentity(identity);
    return (0, node_crypto_1.createHash)("sha256").update(JSON.stringify({
        appPath: identity.appPath,
        appContentsSha256: identity.appContentsSha256.toLowerCase(),
        appAsarSha256: identity.appAsarSha256.toLowerCase(),
        asarHeaderSha256: identity.asarHeaderSha256.toLowerCase(),
        loaderPath: identity.loaderPath,
        loaderSha256: identity.loaderSha256.toLowerCase(),
        metadataSha256: identity.metadataSha256.toLowerCase(),
        runtimeMainPath: identity.runtimeMainPath,
        runtimeMainSha256: identity.runtimeMainSha256.toLowerCase(),
        backendPath: identity.backendPath,
        backendSha256: identity.backendSha256.toLowerCase(),
        backendVersion: identity.backendVersion,
        backendArchitecture: identity.backendArchitecture,
        signatureReceiptSha256: identity.signatureReceiptSha256.toLowerCase(),
        policyDigest: identity.policyDigest.toLowerCase(),
    })).digest("hex");
}
function isAppliedPendingLaunchGrantV1(value) {
    if (!isRecord(value))
        return false;
    if (Object.keys(value).some((key) => FORBIDDEN_PREMAIN_KEYS.has(key)))
        return false;
    if (value.schemaVersion !== exports.APPLIED_PENDING_LAUNCH_GRANT_SCHEMA_VERSION
        || value.kind !== "applied-pending-launch-grant"
        || typeof value.transactionId !== "string"
        || typeof value.attempt !== "number"
        || !Number.isSafeInteger(value.attempt)
        || typeof value.nonce !== "string"
        || typeof value.issuedAt !== "string"
        || typeof value.expiresAt !== "string"
        || typeof value.authoritySha256 !== "string"
        || typeof value.acceptedBuildReceiptSha256 !== "string"
        || !isProtectedEnvironmentState(value.environment)
        || !isProtectedLaunchIdentity(value.identity))
        return false;
    if (value.consumedBy !== null) {
        if (!isRecord(value.consumedBy)
            || !Number.isSafeInteger(value.consumedBy.desktopPid)
            || typeof value.consumedBy.desktopKernelStart !== "string"
            || typeof value.consumedBy.consumedAt !== "string")
            return false;
    }
    try {
        assertTransactionAndAttempt(value.transactionId, value.attempt);
        assertTimestamp(value.issuedAt, "Grant issuedAt");
        assertTimestamp(value.expiresAt, "Grant expiresAt");
        if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt))
            return false;
        if (!isNonce(value.nonce))
            return false;
        assertSha256(value.authoritySha256, "Launch grant authority digest");
        assertSha256(value.acceptedBuildReceiptSha256, "Accepted build receipt digest");
        assertProtectedEnvironmentState(value.environment);
        assertProtectedLaunchIdentity(value.identity);
    }
    catch {
        return false;
    }
    return true;
}
function isProtectedEnvironmentState(value) {
    if (!isRecord(value)
        || value.schemaVersion !== 2
        || (value.uiFeatures !== "off" && value.uiFeatures !== "on")
        || (value.mcpSafetyProvider !== "managed-turn-idle" && value.mcpSafetyProvider !== "official-bundled-degraded")
        || (value.recoveryState !== "normal-protected" && value.recoveryState !== "pristine-openai-recovery")) {
        return false;
    }
    return (value.recoveryState === "normal-protected" && value.mcpSafetyProvider === "managed-turn-idle")
        || (value.recoveryState === "pristine-openai-recovery"
            && value.uiFeatures === "off"
            && value.mcpSafetyProvider === "official-bundled-degraded");
}
function isProtectedLaunchIdentity(value) {
    if (!isRecord(value))
        return false;
    const stringFields = [
        "appPath",
        "appContentsSha256",
        "appAsarSha256",
        "asarHeaderSha256",
        "loaderPath",
        "loaderSha256",
        "metadataSha256",
        "runtimeMainPath",
        "runtimeMainSha256",
        "backendPath",
        "backendSha256",
        "backendVersion",
        "signatureReceiptSha256",
        "policyDigest",
    ];
    return stringFields.every((field) => typeof value[field] === "string")
        && value.backendArchitecture === "arm64";
}
function assertProtectedEnvironmentState(state) {
    if (!isProtectedEnvironmentState(state)) {
        throw new Error("Protected environment state is invalid or not an allowed provider/recovery pairing");
    }
}
function assertProtectedLaunchIdentity(identity) {
    if (!isProtectedLaunchIdentity(identity))
        throw new Error("Protected launch identity is invalid");
    for (const path of [identity.appPath, identity.loaderPath, identity.runtimeMainPath, identity.backendPath]) {
        if (!(0, node_path_1.isAbsolute)(path) || (0, node_path_1.resolve)(path) !== path) {
            throw new Error("Protected launch identity paths must be exact and absolute");
        }
    }
    for (const digest of [
        identity.appContentsSha256,
        identity.appAsarSha256,
        identity.asarHeaderSha256,
        identity.loaderSha256,
        identity.metadataSha256,
        identity.runtimeMainSha256,
        identity.backendSha256,
        identity.signatureReceiptSha256,
        identity.policyDigest,
    ])
        assertSha256(digest, "Protected launch identity digest");
    if (!isNonEmptyText(identity.backendVersion)) {
        throw new Error("Protected launch identity backend version is invalid");
    }
}
function assertExactBackendIdentity(identity, deps) {
    const status = (0, node_fs_1.lstatSync)(identity.backendPath);
    if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error("managed-backend-not-regular-file");
    }
    if (deps.sha256File(identity.backendPath).toLowerCase() !== identity.backendSha256.toLowerCase()) {
        throw new Error("managed-backend-digest-mismatch");
    }
    if (deps.probeVersion(identity.backendPath) !== identity.backendVersion) {
        throw new Error("managed-backend-version-mismatch");
    }
    if (deps.probeArchitecture(identity.backendPath) !== identity.backendArchitecture) {
        throw new Error("managed-backend-architecture-mismatch");
    }
}
function assertExactLaunchIdentity(identity, environment, deps) {
    const asarPath = (0, node_path_1.join)(identity.appPath, "Contents", "Resources", "app.asar");
    const expectedLoaderPath = `${asarPath}/protected-loader.cjs`;
    // Runtime authority is intentionally external to app.asar, but it must be
    // exact and independently bound. The app/asar/loader/metadata all remain
    // in the sealed bundle.
    if (identity.loaderPath !== expectedLoaderPath)
        throw new Error("protected-loader-path-mismatch");
    if (identity.appContentsSha256.toLowerCase() !== deps.fingerprintAppContents(identity.appPath).toLowerCase()) {
        throw new Error("protected-app-contents-digest-mismatch");
    }
    if (identity.appAsarSha256.toLowerCase() !== deps.sha256File(asarPath).toLowerCase()) {
        throw new Error("protected-app-asar-digest-mismatch");
    }
    if (identity.asarHeaderSha256.toLowerCase() !== deps.readAsarHeader(asarPath).toLowerCase()) {
        throw new Error("protected-app-asar-header-mismatch");
    }
    if (identity.loaderSha256.toLowerCase() !== (0, node_crypto_1.createHash)("sha256").update(deps.readAsarEntry(asarPath, "protected-loader.cjs")).digest("hex")) {
        throw new Error("protected-loader-digest-mismatch");
    }
    if (identity.metadataSha256.toLowerCase() !== (0, node_crypto_1.createHash)("sha256").update(deps.readAsarEntry(asarPath, "tweakers-protected.json")).digest("hex")) {
        throw new Error("protected-metadata-digest-mismatch");
    }
    if (identity.runtimeMainSha256.toLowerCase() !== deps.sha256File(identity.runtimeMainPath).toLowerCase()) {
        throw new Error("protected-runtime-main-digest-mismatch");
    }
    const signature = deps.readSignature(identity.appPath);
    if (signature === null || identity.signatureReceiptSha256.toLowerCase() !== (0, node_crypto_1.createHash)("sha256").update(signature).digest("hex")) {
        throw new Error("protected-signature-receipt-mismatch");
    }
    const policy = (0, node_crypto_1.createHash)("sha256").update(JSON.stringify({
        schemaVersion: 2, provider: environment.mcpSafetyProvider, uiFeatures: environment.uiFeatures,
    })).digest("hex");
    if (identity.policyDigest.toLowerCase() !== policy)
        throw new Error("protected-policy-digest-mismatch");
}
function fingerprintProtectedAppContents(appRoot) {
    const root = (0, node_path_1.join)(appRoot, "Contents");
    const hash = (0, node_crypto_1.createHash)("sha256");
    const visit = (directory) => {
        for (const entry of (0, node_fs_1.readdirSync)(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            if (entry.name === ".DS_Store")
                continue;
            const path = (0, node_path_1.join)(directory, entry.name);
            hash.update((0, node_path_1.relative)(root, path));
            if (entry.isDirectory())
                visit(path);
            else if (entry.isFile())
                hash.update((0, node_fs_1.readFileSync)(path));
            else if (entry.isSymbolicLink())
                hash.update(`symlink:${(0, node_fs_1.readlinkSync)(path)}`);
        }
    };
    visit(root);
    return hash.digest("hex");
}
function assertNoPostMainFields(value) {
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_PREMAIN_KEYS.has(key)) {
            throw new Error(`pre-main grant must not contain post-main field ${key}`);
        }
    }
}
function backendSummary(identity) {
    return {
        path: identity.backendPath,
        sha256: identity.backendSha256.toLowerCase(),
        version: identity.backendVersion,
        architecture: identity.backendArchitecture,
    };
}
function assertTransactionAndAttempt(transactionId, attempt) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(transactionId)) {
        throw new Error("Protected launch transaction ID is invalid");
    }
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
        throw new Error("Protected launch attempt is invalid");
    }
}
function assertTimestamp(value, label) {
    if (!ISO_TIMESTAMP_RE.test(value) || !Number.isFinite(Date.parse(value))) {
        throw new Error(`${label} is invalid`);
    }
}
function assertSha256(value, label) {
    if (!SHA256_RE.test(value))
        throw new Error(`${label} is invalid`);
}
function isNonce(value) {
    return value.length >= 16 && value.length <= 256 && /^[A-Za-z0-9._-]+$/.test(value);
}
function exactAbsolutePath(value) {
    return typeof value === "string" && (0, node_path_1.isAbsolute)(value) && (0, node_path_1.resolve)(value) === value;
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isNonEmptyText(value) {
    return typeof value === "string" && value.length > 0 && value.trim() === value;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=protected-bootstrap.js.map
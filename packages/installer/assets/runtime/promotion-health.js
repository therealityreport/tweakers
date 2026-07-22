"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROMOTION_SURFACE_NAMES = exports.PROMOTION_RENDERER_NONCE_QUERY = exports.PROMOTION_RENDERER_IPC_CHANNEL = void 0;
exports.promotionRendererDocumentUrl = promotionRendererDocumentUrl;
exports.promotionRendererLoadRejection = promotionRendererLoadRejection;
exports.createPromotionRendererProofTracker = createPromotionRendererProofTracker;
exports.hasAuthenticatedSessionCookie = hasAuthenticatedSessionCookie;
exports.hasAuthenticatedCodexToken = hasAuthenticatedCodexToken;
exports.readCodexAuth = readCodexAuth;
exports.answerPromotionHealthRequest = answerPromotionHealthRequest;
const node_fs_1 = require("node:fs");
const node_crypto_1 = require("node:crypto");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_url_1 = require("node:url");
exports.PROMOTION_RENDERER_IPC_CHANNEL = "tweaker:promotion-renderer-proof";
exports.PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
/**
 * Selects the real renderer entry from the candidate's own ASAR. The one-shot
 * health process deliberately skips Codex's normal bootstrap, so its app://
 * protocol is not registered. Electron's ASAR-aware file loader still resolves
 * the renderer's relative assets from this exact packaged document.
 */
function promotionRendererDocumentUrl(resourcesPath, nonce) {
    const url = (0, node_url_1.pathToFileURL)((0, node_path_1.join)(resourcesPath, "app.asar", "webview", "index.html"));
    url.searchParams.set(exports.PROMOTION_RENDERER_NONCE_QUERY, nonce);
    return url.toString();
}
function promotionRendererLoadRejection(error, requestedUrl) {
    const value = error !== null && typeof error === "object"
        ? error
        : null;
    return {
        errorCode: typeof value?.errno === "number" ? value.errno : -2,
        errorDescription: error instanceof Error ? error.message : String(error),
        url: typeof value?.url === "string" && value.url.length > 0 ? value.url : requestedUrl,
    };
}
/**
 * Tracks the candidate's real renderer without importing Electron into tests.
 * Every positive signal is bound to one nonce, URL, preload, and webContents.
 */
function createPromotionRendererProofTracker(expected) {
    let expectedWebContentsId = null;
    let windowCreated = false;
    let didFinishLoad = false;
    let handshake = false;
    let failed = false;
    let rendererStorageSelfTest = "unknown";
    const expectedRenderer = (webContentsId) => (expectedWebContentsId !== null && webContentsId === expectedWebContentsId);
    const validId = (value) => Number.isSafeInteger(value) && value > 0;
    return {
        windowCreated(observation) {
            if (expectedWebContentsId !== null) {
                failed = true;
                return;
            }
            expectedWebContentsId = validId(observation.webContentsId) ? observation.webContentsId : null;
            windowCreated = expectedWebContentsId !== null
                && observation.url === expected.url
                && observation.preloadPath === expected.preloadPath;
            if (!windowCreated)
                failed = true;
        },
        didFinishLoad(observation) {
            if (!expectedRenderer(observation.webContentsId))
                return;
            if (observation.url !== expected.url) {
                failed = true;
                return;
            }
            didFinishLoad = true;
        },
        didFailLoad(observation) {
            if (!expectedRenderer(observation.webContentsId))
                return;
            // Any did-fail-load on the proof renderer, including ERR_FAILED (-2),
            // invalidates the one-shot proof even if a later navigation succeeds.
            void observation.errorCode;
            void observation.errorDescription;
            void observation.url;
            failed = true;
            rendererStorageSelfTest = "fail";
        },
        renderProcessGone(observation) {
            if (!expectedRenderer(observation.webContentsId))
                return;
            void observation.reason;
            void observation.exitCode;
            failed = true;
            rendererStorageSelfTest = "fail";
        },
        rendererHandshake(observation) {
            if (!expectedRenderer(observation.webContentsId))
                return;
            if (observation.nonce !== expected.nonce
                || observation.url !== expected.url
                || observation.lifecycle !== "renderer-mounted"
                || !validHealthValue(observation.rendererStorageSelfTest)) {
                failed = true;
                rendererStorageSelfTest = "fail";
                return;
            }
            handshake = true;
            rendererStorageSelfTest = observation.rendererStorageSelfTest;
        },
        result() {
            if (failed)
                return { hostReady: "fail", rendererStorageSelfTest: "fail" };
            return {
                hostReady: windowCreated && didFinishLoad && handshake ? "pass" : "unknown",
                rendererStorageSelfTest: handshake ? rendererStorageSelfTest : "unknown",
            };
        },
    };
}
exports.PROMOTION_SURFACE_NAMES = [
    "app",
    "runtime",
    "tweakTree",
    "tweakersConfig",
    "codexConfig",
    "namespaceData",
    "mainStorage",
    "policy",
];
function hasAuthenticatedSessionCookie(cookies, now = Date.now()) {
    return cookies.some((cookie) => {
        const domain = (cookie.domain ?? "").replace(/^\./, "").toLowerCase();
        const knownDomain = domain === "chatgpt.com" || domain.endsWith(".chatgpt.com") ||
            domain === "openai.com" || domain.endsWith(".openai.com");
        const knownSessionName = /^(?:__Secure-|__Host-)?(?:next-auth|authjs)\.session-token(?:\.\d+)?$/.test(cookie.name);
        const notExpired = cookie.expirationDate === undefined || cookie.expirationDate * 1_000 > now;
        return knownDomain && knownSessionName && cookie.secure === true && cookie.httpOnly === true &&
            typeof cookie.value === "string" && cookie.value.length > 0 && notExpired;
    });
}
/**
 * The Codex / ChatGPT desktop app does NOT authenticate with a web
 * next-auth.session-token cookie. It signs in with a Codex account token stored
 * in `~/.codex/auth.json` (auth_mode "chatgpt") or an API key. The id_token is
 * short-lived and refreshed roughly hourly, so a durable session is proven by a
 * refresh token / account id (or an API key) — never by the id_token's expiry.
 */
function hasAuthenticatedCodexToken(auth) {
    if (!auth || typeof auth !== "object")
        return false;
    const apiKey = typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0;
    const tokens = auth.tokens ?? undefined;
    const durableSession = !!tokens && ((typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0) ||
        (typeof tokens.account_id === "string" && tokens.account_id.length > 0 &&
            typeof tokens.access_token === "string" && tokens.access_token.length > 0));
    return apiKey || durableSession;
}
function readCodexAuth(codexHome) {
    try {
        const home = codexHome || process.env.CODEX_HOME || (0, node_path_1.join)((0, node_os_1.homedir)(), ".codex");
        return JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(home, "auth.json"), "utf8"));
    }
    catch {
        return null;
    }
}
async function answerPromotionHealthRequest(userRoot, probes, options = {}) {
    const requestFile = (0, node_path_1.join)(userRoot, "health", "request.json");
    const receiptFile = (0, node_path_1.join)(userRoot, "health", "promotion.json");
    let request;
    try {
        const stat = (0, node_fs_1.lstatSync)(requestFile);
        if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 256 * 1024)
            return false;
        if (typeof process.getuid === "function" && stat.uid !== process.getuid())
            return false;
        request = JSON.parse((0, node_fs_1.readFileSync)(requestFile, "utf8"));
        const now = (options.now ?? new Date()).getTime();
        const requestedAt = Date.parse(request.requestedAt);
        if (!Number.isFinite(requestedAt) || requestedAt > now + 5_000 || now - requestedAt > (options.maxAgeMs ?? 60_000))
            return false;
        if (!validPromotionRequest(request))
            return false;
    }
    catch {
        return false;
    }
    const safe = async (probe) => {
        try {
            const value = await probe();
            return value === "pass" || value === "fail" || value === "unknown" ? value : "unknown";
        }
        catch {
            return "unknown";
        }
    };
    const permissions = Object.fromEntries(await Promise.all(request.requiredPermissions.map(async (permission) => [
        permission,
        await safe(() => probes.declaredPermission(permission)),
    ])));
    const authenticatedSession = await safe(() => probes.authenticatedSession());
    const receipt = request.schemaVersion === 1
        ? {
            schemaVersion: 1,
            observedAt: (options.now ?? new Date()).toISOString(),
            app: request.app,
            runtimeHash: request.runtimeHash,
            hostReady: "pass",
            authenticatedSession,
            declaredPermissions: permissions,
        }
        : await buildV2Receipt(request, probes, permissions, authenticatedSession, options.now ?? new Date(), safe);
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(receiptFile), { recursive: true, mode: 0o700 });
    const temporary = `${receiptFile}.${process.pid}.${(0, node_crypto_1.randomUUID)()}.tmp`;
    const fd = (0, node_fs_1.openSync)(temporary, "wx", 0o600);
    try {
        (0, node_fs_1.writeFileSync)(fd, `${JSON.stringify(receipt, null, 2)}\n`);
        (0, node_fs_1.fsyncSync)(fd);
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
    (0, node_fs_1.chmodSync)(temporary, 0o600);
    (0, node_fs_1.renameSync)(temporary, receiptFile);
    (0, node_fs_1.chmodSync)(receiptFile, 0o600);
    try {
        (0, node_fs_1.unlinkSync)(requestFile);
    }
    catch { /* one-shot request already consumed */ }
    return true;
}
async function buildV2Receipt(request, probes, permissions, authenticatedSession, now, safe) {
    const surfaces = Object.fromEntries(await Promise.all(exports.PROMOTION_SURFACE_NAMES.map(async (surface) => {
        const expected = request.surfaces[surface];
        let observedHash = "unknown";
        try {
            const observed = await probes.promotionSurface?.(surface);
            if (validPromotionHash(observed))
                observedHash = observed;
        }
        catch { /* fail closed below */ }
        return [surface, {
                preimageHash: expected.preimageHash,
                expectedHash: expected.afterHash,
                observedHash,
                status: observedHash === expected.afterHash ? "pass" : observedHash === "unknown" ? "unknown" : "fail",
            }];
    })));
    let observedUserQuestions = null;
    try {
        const observed = await probes.userQuestionsHealth?.();
        if (validUserQuestionsObservation(observed))
            observedUserQuestions = observed;
    }
    catch { /* fail closed below */ }
    const expectedUserQuestions = request.userQuestions;
    const hostReady = await safe(() => probes.rendererReady?.() ?? "unknown");
    const identity = observedUserQuestions &&
        observedUserQuestions.id === expectedUserQuestions.id &&
        observedUserQuestions.version === expectedUserQuestions.version &&
        observedUserQuestions.payloadHash === expectedUserQuestions.payloadHash
        ? "pass" : observedUserQuestions ? "fail" : "unknown";
    const userQuestions = {
        expected: expectedUserQuestions,
        observed: observedUserQuestions ? {
            id: observedUserQuestions.id,
            version: observedUserQuestions.version,
            payloadHash: observedUserQuestions.payloadHash,
        } : null,
        identity,
        mainLifecycle: observedUserQuestions?.mainLifecycle ?? "unknown",
        brokerSelfTest: observedUserQuestions?.brokerSelfTest ?? "unknown",
        schemaSelfTest: observedUserQuestions?.schemaSelfTest ?? "unknown",
        rendererStorageSelfTest: observedUserQuestions?.rendererStorageSelfTest ?? "unknown",
        mcpConflictCount: observedUserQuestions?.mcpConflictCount ?? null,
        zeroMcpConflicts: observedUserQuestions
            ? observedUserQuestions.mcpConflictCount === 0 ? "pass" : "fail"
            : "unknown",
    };
    const allSurfacesPass = Object.values(surfaces).every((surface) => surface.status === "pass");
    const allPermissionsPass = Object.values(permissions).every((permission) => permission === "pass");
    const userQuestionsPass = [
        userQuestions.identity,
        userQuestions.mainLifecycle,
        userQuestions.brokerSelfTest,
        userQuestions.schemaSelfTest,
        userQuestions.rendererStorageSelfTest,
        userQuestions.zeroMcpConflicts,
    ].every((value) => value === "pass");
    return {
        schemaVersion: 2,
        observedAt: now.toISOString(),
        app: request.app,
        hostReady,
        authenticatedSession,
        declaredPermissions: permissions,
        surfaces,
        userQuestions,
        promotionReady: hostReady === "pass" && allSurfacesPass && allPermissionsPass && userQuestionsPass && authenticatedSession === "pass"
            ? "pass" : "fail",
    };
}
function validPromotionRequest(value) {
    if (!plainRecord(value))
        return false;
    if (value.schemaVersion === 1) {
        if (!exactKeys(value, ["schemaVersion", "requestedAt", "app", "runtimeHash", "requiredPermissions"]))
            return false;
        return validApp(value.app) && typeof value.runtimeHash === "string" && validPermissions(value.requiredPermissions);
    }
    if (value.schemaVersion !== 2 || !exactKeys(value, ["schemaVersion", "requestedAt", "app", "requiredPermissions", "surfaces", "userQuestions"]))
        return false;
    if (!validApp(value.app) || !validPermissions(value.requiredPermissions) || !plainRecord(value.surfaces))
        return false;
    if (!exactKeys(value.surfaces, [...exports.PROMOTION_SURFACE_NAMES]))
        return false;
    const surfaces = value.surfaces;
    for (const surface of exports.PROMOTION_SURFACE_NAMES) {
        const expectation = surfaces[surface];
        if (!plainRecord(expectation) || !exactKeys(expectation, ["preimageHash", "afterHash"]))
            return false;
        if (!validPromotionHash(expectation.preimageHash) || !validPromotionHash(expectation.afterHash))
            return false;
    }
    if (surfaces.app.afterHash !== value.app.hash)
        return false;
    if (!plainRecord(value.userQuestions) || !exactKeys(value.userQuestions, ["id", "version", "payloadHash"]))
        return false;
    return value.userQuestions.id === "co.tweakers.user-questions" &&
        typeof value.userQuestions.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.userQuestions.version) &&
        validPromotionHash(value.userQuestions.payloadHash) && value.userQuestions.payloadHash !== "missing";
}
function validApp(value) {
    return plainRecord(value) && exactKeys(value, ["version", "build", "hash"]) &&
        typeof value.version === "string" && value.version.length > 0 &&
        typeof value.build === "string" && value.build.length > 0 &&
        typeof value.hash === "string" && value.hash.length > 0;
}
function validPermissions(value) {
    return Array.isArray(value) && value.length <= 64 && new Set(value).size === value.length &&
        value.every((permission) => typeof permission === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(permission));
}
function validPromotionHash(value) {
    return value === "missing" || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}
function validUserQuestionsObservation(value) {
    if (!plainRecord(value) || !exactKeys(value, [
        "id", "version", "payloadHash", "mainLifecycle", "brokerSelfTest", "schemaSelfTest", "rendererStorageSelfTest", "mcpConflictCount",
    ]))
        return false;
    return typeof value.id === "string" && typeof value.version === "string" && validPromotionHash(value.payloadHash) &&
        validHealthValue(value.mainLifecycle) && validHealthValue(value.brokerSelfTest) && validHealthValue(value.schemaSelfTest) &&
        validHealthValue(value.rendererStorageSelfTest) &&
        Number.isInteger(value.mcpConflictCount) && value.mcpConflictCount >= 0;
}
function validHealthValue(value) {
    return value === "pass" || value === "fail" || value === "unknown";
}
function plainRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
//# sourceMappingURL=promotion-health.js.map
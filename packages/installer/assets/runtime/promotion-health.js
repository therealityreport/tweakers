"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROMOTION_SURFACE_NAMES = exports.PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL = exports.PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL = exports.PROMOTION_ORIGINAL_RENDERER_URL = exports.PROMOTION_RENDERER_HOST = exports.PROMOTION_RENDERER_SCHEME = exports.PROMOTION_RENDERER_NONCE_QUERY = exports.PROMOTION_RENDERER_AUTH_CHANNEL = exports.PROMOTION_RENDERER_IPC_CHANNEL = void 0;
exports.canonicalPromotionOriginalRendererUrl = canonicalPromotionOriginalRendererUrl;
exports.promotionOriginalRendererEvidenceUrl = promotionOriginalRendererEvidenceUrl;
exports.promotionOriginalRendererLogUrl = promotionOriginalRendererLogUrl;
exports.authorizePromotionOriginalRenderer = authorizePromotionOriginalRenderer;
exports.createPromotionOriginalRendererProofTracker = createPromotionOriginalRendererProofTracker;
exports.authorizePromotionRenderer = authorizePromotionRenderer;
exports.validatePromotionRendererHandshake = validatePromotionRendererHandshake;
exports.promotionRendererDocumentUrl = promotionRendererDocumentUrl;
exports.promotionRendererAssetRoute = promotionRendererAssetRoute;
exports.promotionRendererAssetMimeType = promotionRendererAssetMimeType;
exports.createPromotionRendererProtocolResponder = createPromotionRendererProtocolResponder;
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
exports.PROMOTION_RENDERER_IPC_CHANNEL = "tweaker:promotion-renderer-proof";
exports.PROMOTION_RENDERER_AUTH_CHANNEL = "tweaker:promotion-renderer-authorize";
exports.PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
exports.PROMOTION_RENDERER_SCHEME = "app";
exports.PROMOTION_RENDERER_HOST = "-";
exports.PROMOTION_ORIGINAL_RENDERER_URL = "app://-/index.html";
exports.PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL = "tweaker:promotion-original-renderer-authorize";
exports.PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL = "tweaker:promotion-original-renderer-proof";
const PROMOTION_ORIGINAL_RENDERER_QUERY_KEYS = new Set(["hostId", "initialRoute"]);
/**
 * Accept the production Owl document, including its exact observed query,
 * without accepting a synthetic proof nonce or URL normalization ambiguity.
 */
function canonicalPromotionOriginalRendererUrl(value) {
    if (typeof value !== "string"
        || value.length === 0
        || value.length > 8_192
        || /[\u0000-\u001f\u007f]/.test(value))
        return null;
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== "app:"
        || parsed.hostname !== "-"
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.port !== ""
        || parsed.pathname !== "/index.html"
        || parsed.hash !== ""
        || parsed.searchParams.has(exports.PROMOTION_RENDERER_NONCE_QUERY)
        || parsed.toString() !== value)
        return null;
    const queryKeys = [...parsed.searchParams.keys()];
    if (queryKeys.some((key) => !PROMOTION_ORIGINAL_RENDERER_QUERY_KEYS.has(key))
        || new Set(queryKeys).size !== queryKeys.length)
        return null;
    const hostId = parsed.searchParams.get("hostId");
    const initialRoute = parsed.searchParams.get("initialRoute");
    if (hostId !== null && (!/^[A-Za-z0-9._:-]{1,256}$/.test(hostId)))
        return null;
    if (initialRoute !== null && (initialRoute.length === 0
        || initialRoute.length > 2_048
        || !initialRoute.startsWith("/")
        || /[\u0000-\u001f\u007f]/.test(initialRoute)))
        return null;
    return value;
}
function promotionOriginalRendererEvidenceUrl(value) {
    if (value === null || canonicalPromotionOriginalRendererUrl(value) === null) {
        return { canonicalUrl: null, queryKeys: [] };
    }
    return {
        canonicalUrl: exports.PROMOTION_ORIGINAL_RENDERER_URL,
        queryKeys: [...new URL(value).searchParams.keys()].sort(),
    };
}
function promotionOriginalRendererLogUrl(value) {
    if (typeof value !== "string")
        return "[redacted-url]";
    const evidence = promotionOriginalRendererEvidenceUrl(value);
    if (evidence.canonicalUrl === null)
        return "[redacted-url]";
    return evidence.queryKeys.length === 0
        ? evidence.canonicalUrl
        : `${evidence.canonicalUrl}?[${evidence.queryKeys.join(",")}:redacted]`;
}
/**
 * Authorizes the dedicated original-main preload synchronously. The renderer
 * sends only its unmodified canonical URL; the main process supplies the nonce
 * after binding the sender to the one hidden, safe BrowserWindow.
 */
function authorizePromotionOriginalRenderer(context, payload, nonce) {
    if (!context.windowAlive)
        return { accepted: false, reason: "proof window unavailable", response: null };
    if (!context.windowHidden)
        return { accepted: false, reason: "proof window visible", response: null };
    if (!context.senderMatches)
        return { accepted: false, reason: "sender mismatch", response: null };
    if (!context.frameMatches)
        return { accepted: false, reason: "frame mismatch", response: null };
    const canonicalUrl = canonicalPromotionOriginalRendererUrl(context.senderUrl);
    if (canonicalUrl === null) {
        return { accepted: false, reason: "sender URL mismatch", response: null };
    }
    if (context.consumed)
        return { accepted: false, reason: "authorization already consumed", response: null };
    if (!plainRecord(payload) || !exactKeys(payload, ["url", "version"])) {
        return { accepted: false, reason: "payload invalid", response: null };
    }
    if (payload.version !== 1 || payload.url !== canonicalUrl) {
        return { accepted: false, reason: "payload binding invalid", response: null };
    }
    if (!PROMOTION_RENDERER_NONCE_PATTERN.test(nonce)) {
        return { accepted: false, reason: "nonce invalid", response: null };
    }
    return {
        accepted: true,
        reason: "accepted",
        response: { version: 1, nonce, url: canonicalUrl },
    };
}
/** Pure state machine for the original Codex renderer promotion gate. */
function createPromotionOriginalRendererProofTracker(nonce) {
    let capturedWindowCount = 0;
    let canonicalWebContentsId = null;
    let canonicalUrl = null;
    let authorized = false;
    let didFinishLoad = false;
    let mounted = false;
    let originalPreload = false;
    let preloadFailed = false;
    let loadFailed = false;
    let rendererExited = false;
    let rendererStorageSelfTest = "unknown";
    let cleanup = "pending";
    let failureReason = null;
    const preloadErrorIds = new Set();
    const isCanonical = (id) => canonicalWebContentsId === id;
    const permanentlyFail = (reason) => {
        if (reason === "canonical renderer load failed")
            loadFailed = true;
        if (reason === "canonical renderer process exited")
            rendererExited = true;
        if (reason === "canonical original preload failed")
            preloadFailed = true;
        if (failureReason === null) {
            failureReason = reason.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
        }
        rendererStorageSelfTest = "fail";
    };
    return {
        windowCaptured() {
            capturedWindowCount += 1;
        },
        eligibleWindow(observation) {
            if (canonicalPromotionOriginalRendererUrl(observation.url) === null
                || !Number.isSafeInteger(observation.webContentsId)
                || observation.webContentsId <= 0
                || !observation.isDefaultSession
                || observation.sandbox !== true
                || observation.contextIsolation !== true
                || observation.nodeIntegration !== false
                || observation.originalPreloadValid !== true) {
                permanentlyFail("eligible renderer was not canonical and sandbox-safe");
                return;
            }
            if (canonicalWebContentsId !== null
                && (canonicalWebContentsId !== observation.webContentsId || canonicalUrl !== observation.url)) {
                permanentlyFail(canonicalWebContentsId !== observation.webContentsId
                    ? "duplicate eligible renderer"
                    : "canonical renderer URL changed");
                return;
            }
            canonicalWebContentsId = observation.webContentsId;
            canonicalUrl = observation.url;
            originalPreload = true;
            if (preloadErrorIds.has(observation.webContentsId))
                permanentlyFail("canonical original preload failed");
        },
        preloadError(webContentsId) {
            preloadErrorIds.add(webContentsId);
            if (isCanonical(webContentsId))
                permanentlyFail("canonical original preload failed");
        },
        authorization(webContentsId) {
            if (!isCanonical(webContentsId)) {
                permanentlyFail("authorization sender was not canonical");
                return;
            }
            if (authorized) {
                permanentlyFail("authorization replayed");
                return;
            }
            authorized = true;
        },
        didFinishLoad(webContentsId, url) {
            if (!isCanonical(webContentsId))
                return;
            if (url !== canonicalUrl) {
                permanentlyFail("canonical renderer finished at wrong URL");
                return;
            }
            didFinishLoad = true;
        },
        rendererHandshake(observation) {
            if (!isCanonical(observation.webContentsId)) {
                permanentlyFail("mount sender was not canonical");
                return;
            }
            if (mounted) {
                permanentlyFail("mount handshake replayed");
                return;
            }
            if (!authorized
                || observation.nonce !== nonce
                || observation.url !== canonicalUrl
                || observation.lifecycle !== "renderer-mounted"
                || !validHealthValue(observation.rendererStorageSelfTest)) {
                permanentlyFail("mount handshake binding invalid");
                return;
            }
            mounted = true;
            rendererStorageSelfTest = observation.rendererStorageSelfTest;
            if (rendererStorageSelfTest !== "pass")
                permanentlyFail("renderer storage self-test failed");
        },
        fail(reason, webContentsId) {
            if (webContentsId !== undefined && !isCanonical(webContentsId))
                return;
            permanentlyFail(reason);
        },
        cleanup(success) {
            cleanup = success ? "pass" : "fail";
            if (!success)
                permanentlyFail("promotion renderer cleanup failed");
        },
        complete() {
            return failureReason !== null || (authorized && didFinishLoad && mounted && rendererStorageSelfTest === "pass");
        },
        result() {
            const proofComplete = authorized && didFinishLoad && mounted && rendererStorageSelfTest === "pass";
            if (failureReason !== null || cleanup === "fail") {
                return { hostReady: "fail", rendererStorageSelfTest: "fail", proofSummary: this.summary() };
            }
            return {
                hostReady: proofComplete && cleanup === "pass" ? "pass" : "unknown",
                rendererStorageSelfTest: mounted ? rendererStorageSelfTest : "unknown",
                proofSummary: this.summary(),
            };
        },
        summary() {
            return {
                capturedWindowCount,
                canonicalWebContentsId,
                canonicalUrl,
                authorized,
                didFinishLoad,
                mounted,
                originalPreload,
                preloadFailed,
                loadFailed,
                rendererExited,
                cleanup,
                failureReason,
            };
        },
    };
}
/** Pure, bounded decision used by the synchronous health-only IPC handler. */
function authorizePromotionRenderer(context, payload, nonce) {
    if (!context.windowAlive)
        return { accepted: false, reason: "proof window unavailable", response: null };
    if (!context.senderMatches)
        return { accepted: false, reason: "sender mismatch", response: null };
    if (!context.frameMatches)
        return { accepted: false, reason: "frame mismatch", response: null };
    if (context.senderUrl !== context.expectedUrl)
        return { accepted: false, reason: "sender URL mismatch", response: null };
    if (context.consumed)
        return { accepted: false, reason: "authorization already consumed", response: null };
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return { accepted: false, reason: "payload invalid", response: null };
    }
    const value = payload;
    if (Object.keys(value).sort().join(",") !== "url,version") {
        return { accepted: false, reason: "payload keys invalid", response: null };
    }
    if (value.version !== 1 || value.url !== context.expectedUrl) {
        return { accepted: false, reason: "payload binding invalid", response: null };
    }
    if (!PROMOTION_RENDERER_NONCE_PATTERN.test(nonce)) {
        return { accepted: false, reason: "nonce invalid", response: null };
    }
    return {
        accepted: true,
        reason: "accepted",
        response: { version: 1, nonce, url: context.expectedUrl },
    };
}
/** Pure, bounded gate in front of the proof tracker's one allowed handshake. */
function validatePromotionRendererHandshake(context, payload, nonce) {
    if (!context.windowAlive)
        return { accepted: false, reason: "proof window unavailable", observation: null };
    if (!context.senderMatches)
        return { accepted: false, reason: "sender mismatch", observation: null };
    if (!context.frameMatches)
        return { accepted: false, reason: "frame mismatch", observation: null };
    if (context.senderUrl !== context.expectedUrl)
        return { accepted: false, reason: "sender URL mismatch", observation: null };
    if (!context.authorizationConsumed)
        return { accepted: false, reason: "authorization required", observation: null };
    if (context.handshakeConsumed)
        return { accepted: false, reason: "handshake already consumed", observation: null };
    if (!plainRecord(payload))
        return { accepted: false, reason: "payload invalid", observation: null };
    if (!exactKeys(payload, ["nonce", "rendererStorageSelfTest", "lifecycle", "url"])) {
        return { accepted: false, reason: "payload keys invalid", observation: null };
    }
    if (payload.nonce !== nonce || payload.url !== context.expectedUrl || payload.lifecycle !== "renderer-mounted") {
        return { accepted: false, reason: "payload binding invalid", observation: null };
    }
    if (!validHealthValue(payload.rendererStorageSelfTest)) {
        return { accepted: false, reason: "storage result invalid", observation: null };
    }
    return {
        accepted: true,
        reason: "accepted",
        observation: {
            nonce,
            url: context.expectedUrl,
            lifecycle: "renderer-mounted",
            rendererStorageSelfTest: payload.rendererStorageSelfTest,
        },
    };
}
const PROMOTION_RENDERER_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Selects the real production renderer origin. The health-only main process
 * owns a temporary app:// handler that serves bytes from its candidate ASAR.
 */
function promotionRendererDocumentUrl(nonce) {
    const url = new URL(`${exports.PROMOTION_RENDERER_SCHEME}://${exports.PROMOTION_RENDERER_HOST}/index.html`);
    url.searchParams.set(exports.PROMOTION_RENDERER_NONCE_QUERY, nonce);
    return url.toString();
}
/**
 * Maps one app://- request to a relative file below the candidate webview.
 * Inspect the raw URL before URL parsing can normalize dot segments, decode the
 * path exactly once, and reject any residual encoding that could hide a second
 * traversal/backslash/NUL decode.
 */
function promotionRendererAssetRoute(requestUrl) {
    const prefix = `${exports.PROMOTION_RENDERER_SCHEME}://${exports.PROMOTION_RENDERER_HOST}`;
    if (!requestUrl.startsWith(`${prefix}/`))
        return null;
    let parsed;
    try {
        parsed = new URL(requestUrl);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== `${exports.PROMOTION_RENDERER_SCHEME}:`
        || parsed.hostname !== exports.PROMOTION_RENDERER_HOST
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.port !== ""
        || parsed.hash !== "")
        return null;
    const pathAndQuery = requestUrl.slice(prefix.length);
    const queryIndex = pathAndQuery.indexOf("?");
    const fragmentIndex = pathAndQuery.indexOf("#");
    const pathEnd = [queryIndex, fragmentIndex]
        .filter((index) => index >= 0)
        .reduce((smallest, index) => Math.min(smallest, index), pathAndQuery.length);
    const rawPath = pathAndQuery.slice(0, pathEnd);
    if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("\\") || rawPath.includes("\0")) {
        return null;
    }
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(rawPath);
    }
    catch {
        return null;
    }
    if (decodedPath.includes("\\")
        || decodedPath.includes("\0")
        || /%[0-9a-f]{2}/i.test(decodedPath))
        return null;
    const segments = decodedPath.slice(1).split("/");
    if (segments.length === 0
        || segments.some((segment) => segment === "" || segment === "." || segment === ".."))
        return null;
    return segments.join("/");
}
function promotionRendererAssetMimeType(relativePath) {
    switch ((0, node_path_1.extname)(relativePath).toLowerCase()) {
        case ".html": return "text/html; charset=utf-8";
        case ".js":
        case ".mjs": return "text/javascript; charset=utf-8";
        case ".css": return "text/css; charset=utf-8";
        case ".json":
        case ".map": return "application/json; charset=utf-8";
        case ".svg": return "image/svg+xml";
        case ".png": return "image/png";
        case ".jpg":
        case ".jpeg": return "image/jpeg";
        case ".gif": return "image/gif";
        case ".webp": return "image/webp";
        case ".avif": return "image/avif";
        case ".ico": return "image/x-icon";
        case ".woff": return "font/woff";
        case ".woff2": return "font/woff2";
        case ".ttf": return "font/ttf";
        case ".otf": return "font/otf";
        case ".wasm": return "application/wasm";
        case ".txt": return "text/plain; charset=utf-8";
        default: return "application/octet-stream";
    }
}
/** Creates the health process's ASAR-aware, read-only app:// responder. */
function createPromotionRendererProtocolResponder(webviewRoot, readFile = node_fs_1.readFileSync) {
    return (request) => {
        const relativePath = promotionRendererAssetRoute(request.url);
        if (!relativePath)
            return new Response(null, { status: 404 });
        try {
            const bytes = readFile((0, node_path_1.join)(webviewRoot, ...relativePath.split("/")));
            return new Response(new Uint8Array(bytes), {
                status: 200,
                headers: {
                    "Content-Type": promotionRendererAssetMimeType(relativePath),
                    "X-Content-Type-Options": "nosniff",
                },
            });
        }
        catch {
            return new Response(null, { status: 404 });
        }
    };
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
    let observedRendererProof = unavailableRendererProofSummary();
    try {
        const observed = await probes.rendererProof?.();
        if (validRendererProofSummary(observed))
            observedRendererProof = observed;
    }
    catch { /* fail closed below */ }
    const rendererProof = rendererProofReceiptSummary(observedRendererProof);
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
    const rendererProofPass = passingRendererProofSummary(observedRendererProof);
    return {
        schemaVersion: 2,
        observedAt: now.toISOString(),
        app: request.app,
        hostReady,
        rendererProof,
        authenticatedSession,
        declaredPermissions: permissions,
        surfaces,
        userQuestions,
        promotionReady: hostReady === "pass" && rendererProofPass && allSurfacesPass && allPermissionsPass && userQuestionsPass && authenticatedSession === "pass"
            ? "pass" : "fail",
    };
}
function rendererProofReceiptSummary(value) {
    const evidenceUrl = promotionOriginalRendererEvidenceUrl(value.canonicalUrl);
    return {
        ...value,
        canonicalUrl: evidenceUrl.canonicalUrl,
        queryKeys: evidenceUrl.queryKeys,
    };
}
function unavailableRendererProofSummary() {
    return {
        capturedWindowCount: 0,
        canonicalWebContentsId: null,
        canonicalUrl: null,
        authorized: false,
        didFinishLoad: false,
        mounted: false,
        originalPreload: false,
        preloadFailed: false,
        loadFailed: false,
        rendererExited: false,
        cleanup: "pending",
        failureReason: "renderer proof unavailable",
    };
}
function validRendererProofSummary(value) {
    if (!plainRecord(value) || !exactKeys(value, [
        "capturedWindowCount",
        "canonicalWebContentsId",
        "canonicalUrl",
        "authorized",
        "didFinishLoad",
        "mounted",
        "originalPreload",
        "preloadFailed",
        "loadFailed",
        "rendererExited",
        "cleanup",
        "failureReason",
    ]))
        return false;
    if (!Number.isSafeInteger(value.capturedWindowCount)
        || value.capturedWindowCount < 0
        || value.capturedWindowCount > 64
        || (value.canonicalWebContentsId !== null && (!Number.isSafeInteger(value.canonicalWebContentsId)
            || value.canonicalWebContentsId <= 0))
        || (value.canonicalUrl !== null && canonicalPromotionOriginalRendererUrl(value.canonicalUrl) === null)
        || typeof value.authorized !== "boolean"
        || typeof value.didFinishLoad !== "boolean"
        || typeof value.mounted !== "boolean"
        || typeof value.originalPreload !== "boolean"
        || typeof value.preloadFailed !== "boolean"
        || typeof value.loadFailed !== "boolean"
        || typeof value.rendererExited !== "boolean"
        || !["pending", "pass", "fail"].includes(value.cleanup)
        || (value.failureReason !== null && (typeof value.failureReason !== "string"
            || value.failureReason.length === 0
            || value.failureReason.length > 256
            || /[\u0000-\u001f\u007f]/.test(value.failureReason))))
        return false;
    return true;
}
function passingRendererProofSummary(value) {
    return value.capturedWindowCount >= 1
        && value.canonicalWebContentsId !== null
        && value.canonicalUrl !== null
        && value.authorized
        && value.didFinishLoad
        && value.mounted
        && value.originalPreload
        && !value.preloadFailed
        && !value.loadFailed
        && !value.rendererExited
        && value.cleanup === "pass"
        && value.failureReason === null;
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
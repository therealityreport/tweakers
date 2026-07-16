"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasAuthenticatedSessionCookie = hasAuthenticatedSessionCookie;
exports.hasAuthenticatedCodexToken = hasAuthenticatedCodexToken;
exports.readCodexAuth = readCodexAuth;
exports.answerPromotionHealthRequest = answerPromotionHealthRequest;
const node_fs_1 = require("node:fs");
const node_crypto_1 = require("node:crypto");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
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
        if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600)
            return false;
        if (typeof process.getuid === "function" && stat.uid !== process.getuid())
            return false;
        request = JSON.parse((0, node_fs_1.readFileSync)(requestFile, "utf8"));
        const now = (options.now ?? new Date()).getTime();
        const requestedAt = Date.parse(request.requestedAt);
        if (request.schemaVersion !== 1 || !Number.isFinite(requestedAt) || requestedAt > now + 5_000 || now - requestedAt > (options.maxAgeMs ?? 60_000))
            return false;
        if (!request.app || typeof request.runtimeHash !== "string" || !Array.isArray(request.requiredPermissions))
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
    const receipt = {
        schemaVersion: 1,
        observedAt: (options.now ?? new Date()).toISOString(),
        app: request.app,
        runtimeHash: request.runtimeHash,
        hostReady: "pass",
        authenticatedSession: await safe(() => probes.authenticatedSession()),
        declaredPermissions: permissions,
    };
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
//# sourceMappingURL=promotion-health.js.map
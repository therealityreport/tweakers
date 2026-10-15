"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StartupPolicySessionV1 = exports.STARTUP_POLICY_BUNDLE_ID = void 0;
exports.isStartupPolicyAuthorization = isStartupPolicyAuthorization;
exports.createStartupPolicyAuthorization = createStartupPolicyAuthorization;
exports.createStartupPolicyHandshakeProof = createStartupPolicyHandshakeProof;
exports.createStartupPolicyHandshake = createStartupPolicyHandshake;
exports.verifyStartupPolicyHandshake = verifyStartupPolicyHandshake;
const node_crypto_1 = require("node:crypto");
exports.STARTUP_POLICY_BUNDLE_ID = "com.therealityreport.tweakers";
function exact(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null)
        && Reflect.ownKeys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key));
}
const safeNonce = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
function isStartupPolicyAuthorization(value, now = Date.now()) {
    return Number.isSafeInteger(now)
        && exact(value, ["version", "scope", "clientKind", "bundleIdentity", "sessionNonce", "nonce", "expiresAt"])
        && [1, 2].includes(value.version) && value.scope === "startup-policy" && value.clientKind === "tweakers"
        && value.bundleIdentity === exports.STARTUP_POLICY_BUNDLE_ID && safeNonce(value.sessionNonce)
        && typeof value.nonce === "string" && /^[A-Za-z0-9_-]{32}$/.test(value.nonce)
        && Number.isSafeInteger(value.expiresAt) && value.expiresAt > now
        && value.expiresAt - now <= (value.version === 2 ? 600_000 : 60_000);
}
function createStartupPolicyAuthorization(sessionNonce, now = Date.now(), preparationMs = 30_000) {
    if (!safeNonce(sessionNonce) || !Number.isSafeInteger(now) || !Number.isSafeInteger(preparationMs)
        || preparationMs < 1 || preparationMs > 600_000 || !Number.isSafeInteger(now + preparationMs))
        throw new Error("Invalid startup policy authorization input");
    return { version: preparationMs > 30_000 ? 2 : 1, scope: "startup-policy", clientKind: "tweakers", bundleIdentity: exports.STARTUP_POLICY_BUNDLE_ID,
        sessionNonce, nonce: (0, node_crypto_1.randomBytes)(24).toString("base64url"), expiresAt: now + preparationMs };
}
function canonicalAuthorization(value) {
    return JSON.stringify({ version: value.version, scope: value.scope, clientKind: value.clientKind,
        bundleIdentity: value.bundleIdentity, sessionNonce: value.sessionNonce, nonce: value.nonce, expiresAt: value.expiresAt });
}
function createStartupPolicyHandshakeProof(secret, authorization) {
    if (secret.length !== 32 || !isStartupPolicyAuthorization(authorization, authorization.expiresAt - 30_000))
        throw new Error("Invalid startup policy proof input");
    return (0, node_crypto_1.createHmac)("sha256", secret).update("startup-policy-v1\0").update(canonicalAuthorization(authorization)).digest("hex");
}
function createStartupPolicyHandshake(secret, authorization) {
    return { version: 1, kind: "startup-policy-handshake", authorization: { ...authorization }, proof: createStartupPolicyHandshakeProof(secret, authorization) };
}
/** Replay ownership belongs to the connection owner, separately from proof verification. */
function verifyStartupPolicyHandshake(secret, value, now = Date.now()) {
    if (secret.length !== 32 || !exact(value, ["version", "kind", "authorization", "proof"])
        || value.version !== 1 || value.kind !== "startup-policy-handshake" || !isStartupPolicyAuthorization(value.authorization, now)
        || typeof value.proof !== "string" || !/^[a-f0-9]{64}$/.test(value.proof))
        return false;
    const expected = createStartupPolicyHandshakeProof(secret, value.authorization);
    return (0, node_crypto_1.timingSafeEqual)(Buffer.from(value.proof, "hex"), Buffer.from(expected, "hex"));
}
const sequence = ["initialize", "initialized", "configRequirements/read", "config/read", "complete"];
function validInitialize(params) {
    return exact(params, ["clientInfo", "capabilities"])
        && exact(params.clientInfo, ["name", "title", "version"])
        && params.clientInfo.name === "codex_desktop" && params.clientInfo.title === "Codex Desktop"
        && typeof params.clientInfo.version === "string" && params.clientInfo.version.trim().length > 0
        && params.clientInfo.version.length <= 128
        && exact(params.capabilities, ["experimentalApi"]) && params.capabilities.experimentalApi === true;
}
/** A capability for these four startup messages only; it grants no renderer identity. */
class StartupPolicySessionV1 {
    index = 0;
    pending = false;
    failed = false;
    get state() { return this.failed ? "failed" : sequence[this.index]; }
    get completed() { return this.state === "complete"; }
    prepare(frame) {
        if (this.failed || this.pending || this.state === "complete") {
            this.fail();
            return false;
        }
        const notification = this.state === "initialized";
        const has = (key) => !!frame && typeof frame === "object" && Object.hasOwn(frame, key);
        const keys = [...(has("jsonrpc") ? ["jsonrpc"] : []), ...(notification
                ? ["method", ...(has("params") ? ["params"] : [])]
                : ["id", "method", "params"])];
        if (!exact(frame, keys) || (has("jsonrpc") && frame.jsonrpc !== "2.0") || frame.method !== this.state
            || (!notification && !(typeof frame.id === "string" && frame.id.length <= 256
                || typeof frame.id === "number" && Number.isSafeInteger(frame.id)))) {
            this.fail();
            return false;
        }
        const valid = this.state === "initialize" ? validInitialize(frame.params)
            : notification ? !has("params") || exact(frame.params, [])
                : this.state === "configRequirements/read" ? exact(frame.params, [])
                    : exact(frame.params, ["includeLayers"]) && frame.params.includeLayers === false;
        if (!valid) {
            this.fail();
            return false;
        }
        this.pending = true;
        return true;
    }
    /** Call only after the parent has delivered a successful response (or accepted notification). */
    complete(success) {
        if (this.failed || !this.pending || success !== true) {
            this.fail();
            return false;
        }
        this.pending = false;
        this.index += 1;
        return true;
    }
    fail() { this.failed = true; this.pending = false; }
}
exports.StartupPolicySessionV1 = StartupPolicySessionV1;
//# sourceMappingURL=startup-policy.js.map
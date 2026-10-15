"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.officialPluginAuthorizationMatchesV1 = officialPluginAuthorizationMatchesV1;
exports.readOfficialPluginProviderV1 = readOfficialPluginProviderV1;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_https_1 = require("node:https");
const node_tls_1 = require("node:tls");
const digest = (value) => (0, node_crypto_1.createHash)("sha256").update(value).digest();
/** Same actor, exact bearer. Credentials and their hashes never leave this private owner. */
function officialPluginAuthorizationMatchesV1(headers, credentials) {
    return typeof headers.authorization === "string" && (0, node_crypto_1.timingSafeEqual)(digest(headers.authorization), digest(`Bearer ${credentials.accessToken}`))
        && (!credentials.chatgptAccountId || headers["chatgpt-account-id"] === credentials.chatgptAccountId);
}
/** Read-only same-origin service metadata, with the child's original upstream trust. */
async function readOfficialPluginProviderV1(input) {
    const base = new URL(input.upstreamBaseUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash
        || !["/backend-api", "/backend-api/"].includes(base.pathname)
        || !/^\/(?:ps\/plugins\/(?:installed|list|workspace\/shared|suggested\/codex|[A-Za-z0-9_~%-]+(?:\/skills\/[A-Za-z0-9_~%-]+)?)|plugins\/featured)$/.test(input.path)
        || input.path.includes("%2f") || input.path.includes("%2F") || input.query.toString().length > 16_384)
        throw new Error("Unsupported stock plugin provider read");
    const environment = input.caEnvironment ?? process.env;
    const original = environment.CODEX_CA_CERTIFICATE || environment.SSL_CERT_FILE;
    const roots = typeof node_tls_1.getCACertificates === "function" ? [...(0, node_tls_1.getCACertificates)("default"), ...(0, node_tls_1.getCACertificates)("system")] : [...node_tls_1.rootCertificates];
    let custom = [];
    if (original) {
        const bytes = await (0, promises_1.readFile)(original);
        if (bytes.length > 4 * 1024 * 1024)
            throw new Error("Invalid stock upstream public CA file");
        try {
            custom = (bytes.toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map(pem => new node_crypto_1.X509Certificate(pem).toString());
        }
        catch {
            throw new Error("Invalid stock upstream public CA file");
        }
        if (!custom.length)
            throw new Error("Invalid stock upstream public CA file");
    }
    if (input.signal.aborted)
        throw new Error("Stock plugin provider read canceled");
    const credentials = input.credentials();
    if (!credentials.accessToken || credentials.accessToken.length > 16_384 || /[\r\n]/.test(credentials.accessToken + credentials.chatgptAccountId))
        throw new Error("Stock plugin provider credentials unavailable");
    const query = input.query.toString(), target = `/backend-api${input.path}${query ? "?" + query : ""}`;
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        input.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 15_000);
        timer.unref();
        const fail = () => reject(new Error("Stock plugin provider read unavailable"));
        const operation = (0, node_https_1.request)({ protocol: "https:", hostname: base.hostname, port: base.port || 443, path: target, method: "GET", signal: controller.signal,
            ca: [...new Set([...roots, ...custom])], rejectUnauthorized: true, agent: false,
            headers: { authorization: `Bearer ${credentials.accessToken}`, ...(credentials.chatgptAccountId ? { "chatgpt-account-id": credentials.chatgptAccountId } : {}),
                "oai-product-sku": "codex", accept: "application/json", "accept-encoding": "identity" } }, incoming => {
            const status = incoming.statusCode ?? 503;
            if (status < 200 || status >= 300) {
                incoming.resume();
                resolve({ status, value: null });
                return;
            }
            let size = 0;
            const chunks = [];
            incoming.on("data", (chunk) => { size += chunk.length; if (size > 16 * 1024 * 1024) {
                controller.abort();
                return;
            } chunks.push(chunk); });
            incoming.once("error", fail);
            incoming.once("end", () => { try {
                resolve({ status, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
            }
            catch {
                fail();
            } });
        });
        const cleanup = () => { clearTimeout(timer); input.signal.removeEventListener("abort", abort); credentials.accessToken = ""; credentials.chatgptAccountId = ""; };
        operation.once("close", cleanup);
        operation.once("error", fail);
        operation.end();
    });
}
//# sourceMappingURL=official-plugin-provider-read.js.map
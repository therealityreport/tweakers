"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startOfficialPluginServiceFacade = startOfficialPluginServiceFacade;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_http_1 = require("node:http");
const node_https_1 = require("node:https");
const node_path_1 = require("node:path");
const node_tls_1 = require("node:tls");
const node_util_1 = require("node:util");
const MAX_ACTIVE = 64, MAX_SOCKETS = 128, MAX_PLUGIN_BODY = 256 * 1024;
const CONNECT_TIMEOUT = 10_000, HEADER_TIMEOUT = 30_000, CLOSE_TIMEOUT = 2_000;
const execute = (0, node_util_1.promisify)(node_child_process_1.execFile);
function publicCertificates(value) {
    const blocks = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    // Parsing rejects broken certificates without including the input in an error.
    return blocks.map(block => { try {
        return new node_crypto_1.X509Certificate(block).toString();
    }
    catch {
        throw new Error("Invalid custom public CA certificate");
    } });
}
function safeRequestTarget(raw) {
    if (!raw || raw.length > 16_384 || !raw.startsWith("/backend-api/") || /[\\\x00-\x20\x7f#]/.test(raw))
        return null;
    const [path, query = ""] = raw.split(/\?(.*)/s);
    try {
        const decoded = decodeURIComponent(path);
        if (/[\\\x00-\x20\x7f]/.test(decoded) || decoded.split("/").some(part => part === "." || part === ".."))
            return null;
    }
    catch {
        return null;
    }
    return { path: path, query: new URLSearchParams(query) };
}
function pluginRoute(method, path) {
    if (path === "/backend-api/ps/plugins/installed")
        return method === "GET" ? "required" : "deny";
    if (["/backend-api/ps/plugins/list", "/backend-api/ps/plugins/workspace/shared", "/backend-api/ps/plugins/suggested/codex", "/backend-api/plugins/featured"].includes(path))
        return method === "GET" ? "optional" : "deny";
    if (/^\/backend-api\/ps\/plugins\/[^/]+\/(install|uninstall)$/.test(path))
        return method === "POST" ? "required" : "deny";
    if (/^\/backend-api\/plugins\/[^/]+\/(enable|uninstall)$/.test(path))
        return method === "POST" ? "required" : "deny";
    if (/^\/backend-api\/ps\/plugins\/[^/]+(?:\/skills\/[^/]+)?$/.test(path))
        return method === "GET" ? "optional" : "deny";
    if (method !== "GET" && /^\/backend-api\/(?:ps\/)?plugins(?:\/|$)/.test(path))
        return "deny";
    return null;
}
function requestHeaders(headers, authority) {
    const result = { ...headers, host: authority };
    // Account binding headers terminate here, never at the provider.
    for (const key of Object.keys(result))
        if (key.startsWith("x-tweakers-"))
            delete result[key];
    return result;
}
/** Private account-child HTTPS origin. It owns no ledger, credential storage or native files. */
async function startOfficialPluginServiceFacade(options) {
    let upstream;
    try {
        upstream = new URL(options.upstreamBaseUrl);
    }
    catch {
        throw new Error("Invalid stock service origin");
    }
    if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.search || upstream.hash
        || !["/backend-api", "/backend-api/"].includes(upstream.pathname))
        throw new Error("Unsupported stock service origin");
    const stamp = options.sessionStamp();
    if (!stamp)
        throw new Error("Stock service session unavailable");
    const rootStat = await (0, promises_1.lstat)(options.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o077))
        throw new Error("Stock service root must be owned and private");
    const environment = options.caEnvironment ?? process.env;
    let custom = [];
    const originalPath = environment.CODEX_CA_CERTIFICATE || environment.SSL_CERT_FILE;
    if (originalPath) {
        try {
            const bytes = await (0, promises_1.readFile)(originalPath);
            if (bytes.length > 4 * 1024 * 1024)
                throw new Error("oversize");
            custom = publicCertificates(bytes.toString("utf8"));
            if (!custom.length)
                throw new Error("empty");
        }
        catch {
            throw new Error("Cannot load stock custom public CA certificates");
        }
    }
    const directory = await (0, promises_1.mkdtemp)((0, node_path_1.join)(options.root, "official-service-"));
    await (0, promises_1.chmod)(directory, 0o700);
    const keyPath = (0, node_path_1.join)(directory, "key.pem"), certificatePath = (0, node_path_1.join)(directory, "certificate.pem"), caPath = (0, node_path_1.join)(directory, "child-ca.pem");
    const authorityKeyPath = (0, node_path_1.join)(directory, "authority-key.pem"), authorityPath = (0, node_path_1.join)(directory, "authority.pem");
    let key, certificate;
    try {
        // System OpenSSL supports both macOS LibreSSL and OpenSSL via a config file.
        const configuration = (0, node_path_1.join)(directory, "openssl.cnf"), authorityConfiguration = (0, node_path_1.join)(directory, "authority.cnf"), requestPath = (0, node_path_1.join)(directory, "server.csr");
        await (0, promises_1.writeFile)(authorityConfiguration, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Tweakers private account CA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n", { mode: 0o600 });
        await (0, promises_1.writeFile)(configuration, "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Tweakers private account service\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n", { mode: 0o600 });
        const executeOptions = { timeout: 15_000, maxBuffer: 64 * 1024 };
        await execute("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "365", "-config", authorityConfiguration, "-keyout", authorityKeyPath, "-out", authorityPath], executeOptions);
        await (0, promises_1.chmod)(authorityKeyPath, 0o600);
        await execute("/usr/bin/openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-config", configuration, "-keyout", keyPath, "-out", requestPath], executeOptions);
        await execute("/usr/bin/openssl", ["x509", "-req", "-in", requestPath, "-CA", authorityPath, "-CAkey", authorityKeyPath, "-CAcreateserial", "-days", "365", "-sha256", "-extfile", configuration, "-extensions", "ext", "-out", certificatePath], executeOptions);
        await (0, promises_1.chmod)(keyPath, 0o600);
        key = await (0, promises_1.readFile)(keyPath);
        certificate = await (0, promises_1.readFile)(certificatePath);
        await (0, promises_1.writeFile)(caPath, [...custom, await (0, promises_1.readFile)(authorityPath, "utf8")].join("\n") + "\n", { mode: 0o600 });
    }
    catch {
        await (0, promises_1.rm)(directory, { recursive: true, force: true });
        throw new Error("Cannot prepare private stock service TLS");
    }
    const ownFingerprint = new node_crypto_1.X509Certificate(await (0, promises_1.readFile)(authorityPath)).fingerprint256;
    // Explicit ca otherwise replaces Node defaults. Include bundled/default and OS
    // roots while excluding this listener's certificate from upstream trust.
    const roots = typeof node_tls_1.getCACertificates === "function" ? [...(0, node_tls_1.getCACertificates)("default"), ...(0, node_tls_1.getCACertificates)("system")] : [...node_tls_1.rootCertificates];
    const upstreamCa = [...new Set([...roots, ...custom])].filter(pem => new node_crypto_1.X509Certificate(pem).fingerprint256 !== ownFingerprint);
    const sockets = new Set(), operations = new Set(), interceptions = new Set(), interceptControllers = new Set();
    let closed = false, authority = "", closing;
    const current = () => { try {
        return !closed && options.sessionStamp() === stamp;
    }
    catch {
        return false;
    } };
    const authorized = (request) => { try {
        return current() && request.headers.host === authority && options.authorize(request.headers);
    }
    catch {
        return false;
    } };
    const server = (0, node_https_1.createServer)({ key, cert: certificate, maxHeaderSize: 32 * 1024 }, (request, response) => { void serve(request, response); });
    server.requestTimeout = 0; // Stock owns long response/tool deadlines.
    server.headersTimeout = HEADER_TIMEOUT;
    server.keepAliveTimeout = 5_000;
    server.on("connection", socket => {
        if (closed || sockets.size >= MAX_SOCKETS) {
            socket.destroy();
            return;
        }
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    server.on("tlsClientError", () => { });
    server.on("clientError", (_error, socket) => socket.destroy());
    const fence = setInterval(() => {
        // Admission and response checks still validate every use. An idle listener
        // has no work to revoke and must not repeatedly inspect native custody.
        if (!operations.size && !sockets.size)
            return;
        if (!current()) {
            for (const operation of operations)
                operation.abort();
            for (const socket of sockets)
                socket.destroy();
        }
    }, 250);
    fence.unref();
    function admit(request) {
        if (!authorized(request) || operations.size >= MAX_ACTIVE)
            return null;
        const controller = new AbortController();
        operations.add(controller);
        return controller;
    }
    function fail(response, status) {
        if (response.destroyed)
            return;
        if (response.headersSent) {
            response.destroy();
            return;
        }
        response.writeHead(status, { "content-type": "text/plain", "connection": "close" });
        response.end("Stock service request unavailable");
    }
    function forward(request, controller) {
        if (sockets.size >= MAX_SOCKETS)
            throw new Error("Stock service capacity reached");
        const proxy = (0, node_https_1.request)({ protocol: "https:", hostname: upstream.hostname, port: upstream.port || 443,
            method: request.method, path: request.url, headers: requestHeaders(request.headers, upstream.host),
            ca: upstreamCa, rejectUnauthorized: true, agent: false, signal: controller.signal });
        let connectTimer = setTimeout(() => proxy.destroy(new Error("Stock service connect timeout")), CONNECT_TIMEOUT);
        const headerTimer = setTimeout(() => proxy.destroy(new Error("Stock service header timeout")), HEADER_TIMEOUT);
        proxy.on("socket", socket => {
            if (closed || sockets.size >= MAX_SOCKETS) {
                socket.destroy();
                return;
            }
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.once("secureConnect", () => { clearTimeout(connectTimer); connectTimer = undefined; });
        });
        const clearTimers = () => { clearTimeout(connectTimer); clearTimeout(headerTimer); };
        proxy.once("response", clearTimers);
        proxy.once("upgrade", clearTimers);
        proxy.once("close", clearTimers);
        return proxy;
    }
    async function serve(request, response) {
        const target = safeRequestTarget(request.url);
        if (!target) {
            fail(response, 400);
            return;
        }
        const controller = admit(request);
        if (!controller) {
            fail(response, current() && authorized(request) ? 503 : 403);
            return;
        }
        const abort = () => controller.abort();
        request.once("aborted", abort);
        response.once("close", abort);
        const release = () => { if (!interceptControllers.has(controller))
            operations.delete(controller); request.off("aborted", abort); response.off("close", abort); };
        response.once("close", release);
        const route = pluginRoute(request.method ?? "GET", target.path);
        try {
            if (route === "deny") {
                fail(response, 405);
                return;
            }
            if (route) {
                let size = 0;
                const chunks = [];
                for await (const chunk of request) {
                    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    size += bytes.length;
                    if (size > MAX_PLUGIN_BODY || (request.method === "GET" && size)) {
                        fail(response, 413);
                        return;
                    }
                    chunks.push(bytes);
                }
                if (!authorized(request) || controller.signal.aborted) {
                    fail(response, 403);
                    return;
                }
                const pending = options.intercept({ method: request.method ?? "GET", path: target.path, query: target.query, body: Buffer.concat(chunks) }, controller.signal);
                interceptions.add(pending);
                interceptControllers.add(controller);
                let reply;
                try {
                    reply = await pending;
                }
                finally {
                    interceptions.delete(pending);
                    interceptControllers.delete(controller);
                    if (response.destroyed)
                        operations.delete(controller);
                }
                if (!authorized(request) || controller.signal.aborted) {
                    fail(response, 403);
                    return;
                }
                if (reply) {
                    response.writeHead(reply.status, reply.headers);
                    response.end(reply.body);
                    return;
                }
                if (route === "required") {
                    fail(response, 503);
                    return;
                }
            }
            const proxy = forward(request, controller);
            proxy.once("error", () => fail(response, 502));
            proxy.once("upgrade", (_incoming, remote) => { remote.destroy(); fail(response, 502); });
            proxy.once("response", incoming => {
                if (!authorized(request)) {
                    controller.abort();
                    fail(response, 403);
                    return;
                }
                response.writeHead(incoming.statusCode ?? 502, incoming.rawHeaders);
                incoming.once("error", () => response.destroy());
                incoming.pipe(response);
            });
            if (route)
                proxy.end();
            else
                request.pipe(proxy);
        }
        catch {
            fail(response, controller.signal.aborted ? 403 : 503);
        }
    }
    server.on("upgrade", (request, socket, head) => {
        if (!safeRequestTarget(request.url) || request.headers.upgrade?.toLowerCase() !== "websocket"
            || pluginRoute(request.method ?? "GET", request.url.split("?")[0])) {
            socket.destroy();
            return;
        }
        const controller = admit(request);
        if (!controller) {
            socket.destroy();
            return;
        }
        const abort = () => controller.abort();
        socket.once("close", () => { abort(); operations.delete(controller); });
        let proxy;
        try {
            proxy = forward(request, controller);
        }
        catch {
            socket.destroy();
            return;
        }
        proxy.once("error", () => socket.destroy());
        proxy.once("upgrade", (incoming, remote, remoteHead) => {
            if (!authorized(request) || controller.signal.aborted) {
                remote.destroy();
                socket.destroy();
                return;
            }
            // No WebSocket implementation: relay the verified upstream handshake and
            // both byte streams, preserving subprotocol, masking and frame boundaries.
            socket.write(`HTTP/${incoming.httpVersion} ${incoming.statusCode} ${incoming.statusMessage}\r\n`);
            for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                socket.write(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}\r\n`);
            socket.write("\r\n");
            if (remoteHead.length)
                socket.write(remoteHead);
            if (head.length)
                remote.write(head);
            const revoke = () => { remote.destroy(); socket.destroy(); };
            controller.signal.addEventListener("abort", revoke, { once: true });
            remote.once("close", () => { socket.destroy(); controller.signal.removeEventListener("abort", revoke); });
            remote.once("error", revoke);
            socket.once("error", revoke);
            remote.pipe(socket);
            socket.pipe(remote);
        });
        proxy.once("response", incoming => {
            if (!authorized(request)) {
                controller.abort();
                socket.destroy();
                return;
            }
            // ServerResponse restores HTTP transfer framing for a declined upgrade.
            const response = new node_http_1.ServerResponse(request);
            response.assignSocket(socket);
            response.shouldKeepAlive = false;
            response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, incoming.rawHeaders);
            incoming.once("error", () => socket.destroy());
            incoming.pipe(response);
        });
        proxy.end();
    });
    try {
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.testPorts?.listen ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("missing listener");
        authority = `127.0.0.1:${address.port}`;
    }
    catch {
        closed = true;
        clearInterval(fence);
        server.close();
        await (0, promises_1.rm)(directory, { recursive: true, force: true });
        throw new Error("Cannot bind private stock service");
    }
    return {
        baseUrl: `https://${authority}/backend-api`, caPath, childEnvironment: { CODEX_CA_CERTIFICATE: caPath },
        stats: () => ({ active: operations.size, sockets: sockets.size, closed }),
        close: () => {
            if (closing)
                return closing;
            closed = true;
            clearInterval(fence);
            closing = (async () => {
                let listenerClosed = !server.listening;
                server.close(() => { listenerClosed = true; });
                for (const operation of operations)
                    operation.abort();
                for (const socket of sockets)
                    socket.destroy();
                const deadline = Date.now() + CLOSE_TIMEOUT;
                while ((!listenerClosed || sockets.size || operations.size || interceptions.size) && Date.now() < deadline)
                    await new Promise(resolve => setTimeout(resolve, 10));
                if (!listenerClosed || sockets.size || operations.size || interceptions.size)
                    return false;
                await (0, promises_1.rm)(directory, { recursive: true, force: true });
                return true;
            })().catch(() => false).finally(() => { closing = undefined; });
            return closing;
        },
    };
}
//# sourceMappingURL=official-plugin-service-facade.js.map
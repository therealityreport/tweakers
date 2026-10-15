import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { startOfficialPluginServiceFacade, type OfficialPluginServiceFacadeOptions } from "../../src/account-router/official-plugin-service-facade";

const binding = { authorization: "Bearer fixture-secret", "chatgpt-account-id": "fixture-account", "x-tweakers-child": "fixture-child" };
type Facade = Awaited<ReturnType<typeof startOfficialPluginServiceFacade>>;

async function fixture(t: test.TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => response.end("upstream"), san = "127.0.0.1") {
  const root = mkdtempSync(join(tmpdir(), "official-facade-"));
  const config = join(root, "fixture.cnf"), keyPath = join(root, "fixture.key"), certPath = join(root, "fixture.crt");
  writeFileSync(config, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Fixture\n[ext]\nsubjectAltName=IP:${san}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-config", config, "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  const key = readFileSync(keyPath), cert = readFileSync(certPath), customPath = join(root, "original-ca.pem");
  // A credential-bearing source file is read transiently; only CERTIFICATE
  // blocks may be copied to child trust. No private key survives in that file.
  writeFileSync(customPath, Buffer.concat([cert, key]), { mode: 0o600 });
  const server = createServer({ key, cert }, handle), sockets = new Set<Duplex>();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const upstreamBaseUrl = `https://127.0.0.1:${address.port}/backend-api`;
  let stamp: string | null = "account/child/auth-session", facade: Facade | undefined;
  const options: OfficialPluginServiceFacadeOptions = { root, upstreamBaseUrl, sessionStamp: () => stamp,
    authorize: headers => headers.authorization === binding.authorization && headers["chatgpt-account-id"] === binding["chatgpt-account-id"] && headers["x-tweakers-child"] === binding["x-tweakers-child"],
    intercept: async () => null, caEnvironment: { CODEX_CA_CERTIFICATE: customPath } };
  const start = async (overrides: Partial<OfficialPluginServiceFacadeOptions> = {}) => { facade = await startOfficialPluginServiceFacade({ ...options, ...overrides }); return facade; };
  t.after(async () => {
    if (facade) assert.equal(await facade.close(), true);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  });
  return { root, key, cert, customPath, options, server, start, setStamp: (value: string | null) => { stamp = value; } };
}

function call(facade: Facade, path: string, options: { method?: string; headers?: Record<string, string>; body?: string; trusted?: boolean } = {}) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: Buffer }>((resolve, reject) => {
    const origin = new URL(facade.baseUrl);
    const request = httpsRequest({ hostname: origin.hostname, port: origin.port, servername: "", path, method: options.method ?? "GET", agent: false,
      ca: options.trusted === false ? undefined : readFileSync(facade.caPath), headers: { ...binding, ...options.headers } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.once("error", reject); request.end(options.body);
  });
}

test("idle facade skips custody polling but rejects the first request after authority changes", async t => {
  const f = await fixture(t);
  let checks = 0, stamp: string | null = "valid";
  const facade = await f.start({ sessionStamp: () => { checks++; return stamp; } });
  const initialChecks = checks;
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(checks, initialChecks);
  stamp = null;
  assert.equal((await call(facade, "/backend-api/accounts/check")).status, 403);
  assert.ok(checks > initialChecks);
});

test("private IP-SAN TLS requires child trust, preserves custom roots and copies no private key", async t => {
  const f = await fixture(t), facade = await f.start();
  assert.match(facade.baseUrl, /^https:\/\/127\.0\.0\.1:\d+\/backend-api$/);
  assert.deepEqual(facade.childEnvironment, { CODEX_CA_CERTIFICATE: facade.caPath });
  assert.equal(lstatSync(dirname(facade.caPath)).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(dirname(facade.caPath), "key.pem")).mode & 0o777, 0o600);
  const trust = readFileSync(facade.caPath, "utf8");
  assert.equal((trust.match(/BEGIN CERTIFICATE/g) ?? []).length, 2); assert.equal(trust.includes("PRIVATE KEY"), false);
  await assert.rejects(call(facade, "/backend-api/accounts/check", { trusted: false }));
  assert.equal((await call(facade, "/backend-api/accounts/check")).body.toString(), "upstream");
  assert.equal(await facade.close(), true); assert.equal(existsSync(facade.caPath), false);
});

test("SSL_CERT_FILE fallback retains fixture trust and invalid/wrong-host upstream certificates fail closed", async t => {
  const f = await fixture(t, undefined, "127.0.0.2"), facade = await f.start({ caEnvironment: { SSL_CERT_FILE: f.customPath } });
  assert.equal((await call(facade, "/backend-api/accounts/check")).status, 502);
  assert.equal((await call(facade, "/backend-api/codex/responses")).status, 502);
});

test("untrusted upstream fails and unsupported base/origin never starts", async t => {
  const f = await fixture(t);
  for (const upstreamBaseUrl of [f.options.upstreamBaseUrl.replace("https:", "http:"), f.options.upstreamBaseUrl.replace("/backend-api", "/api/codex"), "https://user:password@127.0.0.1/backend-api", f.options.upstreamBaseUrl + "?target=other"]) {
    await assert.rejects(startOfficialPluginServiceFacade({ ...f.options, upstreamBaseUrl }), /Unsupported stock service origin/);
  }
  const facade = await f.start({ caEnvironment: {} });
  assert.equal((await call(facade, "/backend-api/accounts/check")).status, 502);
});

test("HTTP paths, query, credentials, status and redirects pass only to the configured origin", async t => {
  const seen: { url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const f = await fixture(t, (request, response) => {
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk)); request.on("end", () => {
      seen.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
      response.writeHead(307, { location: "https://different.invalid/no-follow", "x-fixture": "preserved" }); response.end("redirect body");
    });
  });
  const facade = await f.start();
  for (const path of ["/backend-api/accounts/check?account=one&account=two", "/backend-api/apps/mcp", "/backend-api/codex/responses?stream=true", "/backend-api/codex/responses/compact"]) {
    const response = await call(facade, path, { method: "POST", body: "fixture payload" });
    assert.equal(response.status, 307); assert.equal(response.headers.location, "https://different.invalid/no-follow"); assert.equal(response.body.toString(), "redirect body");
    assert.equal(seen.at(-1)!.url, path); assert.equal(seen.at(-1)!.body, "fixture payload");
    assert.equal(seen.at(-1)!.headers.authorization, binding.authorization); assert.equal(seen.at(-1)!.headers["x-tweakers-child"], undefined);
  }
  assert.equal(seen.length, 4);
});

test("actor, host, raw absolute URL and traversal fences reject before interception or forwarding", async t => {
  let forwarded = 0, intercepted = 0;
  const f = await fixture(t, (_request, response) => { forwarded++; response.end(); });
  const facade = await f.start({ intercept: async () => { intercepted++; return { status: 200, body: "installed" }; } });
  const invalidHeaders: Record<string, string>[] = [{ authorization: "wrong" }, { "chatgpt-account-id": "other" }, { "x-tweakers-child": "other" }, { host: "different.invalid" }];
  for (const headers of invalidHeaders) {
    assert.equal((await call(facade, "/backend-api/ps/plugins/installed", { headers })).status, 403);
  }
  for (const path of ["https://different.invalid/backend-api/accounts/check", "/backend-api/../accounts/check", "/backend-api/%2e%2e/accounts/check", "/backend-api/%5caccounts/check", "/other/accounts/check"]) assert.equal((await call(facade, path)).status, 400);
  f.setStamp(null); assert.equal((await call(facade, "/backend-api/ps/plugins/installed")).status, 403);
  assert.equal(intercepted, 0); assert.equal(forwarded, 0);
});

test("exact plugin paths intercept without headers; required reads and mutations never fall back", async t => {
  let forwarded = 0;
  const seen: Parameters<OfficialPluginServiceFacadeOptions["intercept"]>[0][] = [];
  const f = await fixture(t, (_request, response) => { forwarded++; response.end("detail upstream"); });
  const facade = await f.start({ intercept: async request => { seen.push(request); return request.path.endsWith("/installed") ? { status: 200, body: "local installed" } : null; } });
  assert.equal((await call(facade, "/backend-api/ps/plugins/installed?pageToken=next")).body.toString(), "local installed");
  for (const path of ["/backend-api/ps/plugins/plugin/install", "/backend-api/ps/plugins/plugin/uninstall", "/backend-api/plugins/plugin/enable", "/backend-api/plugins/plugin/uninstall"]) assert.equal((await call(facade, path, { method: "POST", body: "{}" })).status, 503);
  assert.equal(forwarded, 0);
  for (const path of ["/backend-api/ps/plugins/list", "/backend-api/ps/plugins/workspace/shared", "/backend-api/ps/plugins/suggested/codex", "/backend-api/ps/plugins/plugin", "/backend-api/ps/plugins/plugin/skills/skill", "/backend-api/plugins/featured"]) assert.equal((await call(facade, path)).body.toString(), "detail upstream");
  assert.equal(forwarded, 6); assert.equal(seen[0]!.query.get("pageToken"), "next");
  assert.equal(seen[0]!.body.length, 0);
  for (const request of seen) { assert.deepEqual(Object.keys(request).sort(), ["body", "method", "path", "query"]); assert.equal(JSON.stringify(request).includes(binding.authorization), false); }
  assert.equal((await call(facade, "/backend-api/ps/plugins/installed", { method: "POST" })).status, 405);
  for (const path of ["/backend-api/ps/plugins/plugin/enable", "/backend-api/ps/plugins/plugin/disable", "/backend-api/ps/plugins/unknown/action", "/backend-api/plugins/unknown/action"]) assert.equal((await call(facade, path, { method: "POST" })).status, 405);
  assert.equal(forwarded, 6);
});

test("interception exceptions never forward or disclose secrets and plugin bodies are bounded", async t => {
  let forwarded = 0, intercepted = 0;
  const f = await fixture(t, (_request, response) => { forwarded++; response.end(); });
  const facade = await f.start({ intercept: async () => { intercepted++; throw new Error(binding.authorization); } });
  const reply = await call(facade, "/backend-api/ps/plugins/installed"); assert.equal(reply.status, 503); assert.equal(reply.body.includes(binding.authorization), false);
  assert.equal((await call(facade, "/backend-api/ps/plugins/plugin/install", { method: "POST", body: "x".repeat(256 * 1024 + 1) })).status, 413);
  assert.equal((await call(facade, "/backend-api/ps/plugins/installed", { body: "x", headers: { "content-length": "1" } })).status, 413);
  assert.equal(forwarded, 0); assert.equal(intercepted, 1);
});

test("SSE streams before completion and downstream cancellation closes only owned upstream work", async t => {
  let resolveClosed!: () => void; const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const f = await fixture(t, (request, response) => {
    if (request.url === "/backend-api/accounts/check") { response.end("healthy"); return; }
    response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: first\n\n");
    const interval = setInterval(() => response.write("data: next\n\n"), 25); interval.unref();
    response.once("close", () => { clearInterval(interval); resolveClosed(); });
  });
  const facade = await f.start(), origin = new URL(facade.baseUrl);
  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest({ hostname: origin.hostname, port: origin.port, path: "/backend-api/codex/responses", ca: readFileSync(facade.caPath), headers: binding, agent: false }, response => {
      response.once("data", data => { assert.match(data.toString(), /data: first/); response.destroy(); resolve(); });
    }); request.once("error", reject); request.end();
  });
  await closed;
  assert.equal((await call(facade, "/backend-api/accounts/check")).status, 200);
});

test("session changes revoke in-flight responses and close reaps sockets and TLS material", async t => {
  const f = await fixture(t, (_request, response) => { response.writeHead(200); response.write("started"); });
  const facade = await f.start(), origin = new URL(facade.baseUrl);
  const disconnected = new Promise<void>((resolve, reject) => {
    const request = httpsRequest({ hostname: origin.hostname, port: origin.port, path: "/backend-api/codex/responses", ca: readFileSync(facade.caPath), headers: binding, agent: false }, response => {
      response.once("data", () => f.setStamp("different-auth-session")); response.once("close", resolve);
    }); request.once("error", reject); request.end();
  });
  await disconnected; assert.equal(await facade.close(), true); assert.deepEqual(facade.stats(), { active: 0, sockets: 0, closed: true });
  assert.equal(existsSync(dirname(facade.caPath)), false); await assert.rejects(call(facade, "/backend-api/accounts/check"));
});

test("an uncooperative interception preserves TLS material until closure can be proven and retried", async t => {
  const f = await fixture(t); let started!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  const facade = await f.start({ intercept: async (_request, signal) => { started(); await pending; assert.equal(signal.aborted, true); return { status: 200, body: "late" }; } });
  const request = call(facade, "/backend-api/ps/plugins/installed").catch(() => null);
  await admitted; assert.equal(await facade.close(), false); assert.equal(existsSync(facade.caPath), true);
  release(); await request; await new Promise(resolve => setImmediate(resolve));
  assert.equal(await facade.close(), true); assert.equal(existsSync(facade.caPath), false);
});

test("verified WebSocket upgrade preserves handshake, subprotocol, initial bytes and raw frames", async t => {
  const f = await fixture(t), initial = Buffer.from([0x81, 0x02, 0x68, 0x69]), frame = Buffer.from([0x82, 0x82, 1, 2, 3, 4, 0x60, 0x60]);
  f.server.on("upgrade", (request, socket, head) => {
    assert.equal(request.url, "/backend-api/codex/responses?ws=1"); assert.equal(request.headers.authorization, binding.authorization); assert.equal(request.headers["x-tweakers-child"], undefined);
    assert.equal(request.headers["sec-websocket-protocol"], "fixture.protocol");
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: fixture.protocol\r\n\r\n`);
    socket.write(initial); if (head.length) socket.write(head); socket.on("data", bytes => socket.write(bytes));
  });
  const facade = await f.start(), origin = new URL(facade.baseUrl);
  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest({ hostname: origin.hostname, port: origin.port, path: "/backend-api/codex/responses?ws=1", ca: readFileSync(facade.caPath), agent: false,
      headers: { ...binding, upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-protocol": "fixture.protocol" } });
    request.once("error", reject); request.once("upgrade", (response, socket, head) => {
      assert.equal(response.statusCode, 101); assert.equal(response.headers["sec-websocket-protocol"], "fixture.protocol");
      const chunks = [head]; const inspect = () => { const bytes = Buffer.concat(chunks); if (bytes.length >= initial.length + frame.length) { assert.deepEqual(bytes, Buffer.concat([initial, frame])); socket.destroy(); resolve(); } };
      socket.on("data", chunk => { chunks.push(chunk); inspect(); }); socket.once("error", reject); socket.write(frame); inspect();
    }); request.end();
  });
  assert.equal(await facade.close(), true); assert.equal(facade.stats().sockets, 0);
});

test("declined WebSocket upgrades retain upstream status and HTTP transfer framing", async t => {
  const f = await fixture(t);
  f.server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ndeny\r\n0\r\n\r\n"));
  const facade = await f.start();
  const reply = await call(facade, "/backend-api/codex/responses", { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
  assert.equal(reply.status, 401); assert.equal(reply.body.toString(), "deny");
});

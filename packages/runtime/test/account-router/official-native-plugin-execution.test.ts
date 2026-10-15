import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { officialLocalPluginIdV1, readOfficialInstalledPluginSnapshotV1 } from "../../src/account-router/account-continuity";
import { officialBundledAccountPlanV1, officialCanonicalPluginResponseV1 } from "../../src/account-router/official-bundled-adapter";
import { hydrateOfficialSharedPluginLedgerV1, officialPluginEffectiveConfigMatchesV1, prepareOfficialPluginAccountServiceV1 } from "../../src/account-router/official-plugin-service-controller";
import { SharedPluginLedgerStoreV1 } from "../../src/account-router/shared-plugin-ledger";
import { BrokerProcessChild } from "../../src/account-router/broker-host";
import type { OpaqueAccountId } from "../../src/account-router/types";

const backend = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const suppliedHash = "0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28";
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Supplied executable only, isolated homes and local fixture HTTPS only. No desktop. */
test(process.env.TWEAKERS_NATIVE_ROUTING_FIXTURE === "1"
  ? "unchanged native backend isolates private execution routing from public desktop discovery"
  : "unchanged native backend discovers shared local Skills/hooks, respects trust and keeps recommendation IDs", {
  timeout: 90_000, skip: process.env.TWEAKERS_NATIVE_PLUGIN_FIXTURE !== "1" && process.env.TWEAKERS_NATIVE_ROUTING_FIXTURE !== "1",
}, async t => {
  assert.equal(sha(backend), suppliedHash, "rebind native source evidence if its supplied bytes changed");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-local-plugin-proof-"))); chmodSync(root, 0o700);
  const source = join(root, "native-fixture"), stateRoot = join(root, "state"), account = `ar_${"a".repeat(43)}` as OpaqueAccountId;
  const home = join(stateRoot, "accounts", account, "execution-home"), project = join(root, "project");
  const write = (path: string, value: string) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, value, { mode: 0o600 }); };
  mkdirSync(source, { mode: 0o700 }); mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(project, { mode: 0o700 });
  const canonicalId = "native-proof@openai-curated-remote", aliasId = officialLocalPluginIdV1(canonicalId);
  const packageRoot = join(source, "plugins", "cache", "openai-curated-remote", "native-proof", "1.0.0");
  const hookOutput = join(home, "session-hook-ran");
  write(join(source, "config.toml"), `[features]\nplugins=true\ncodex_hooks=true\nremote_plugin=true\nrecommended_plugins=true\nresponses_websockets=false\nresponses_websockets_v2=false\n[plugins.${JSON.stringify(canonicalId)}]\nenabled=true\n`);
  write(join(packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "native-proof", version: "1.0.0", description: "Local fixture", skills: "./skills", hooks: "./hooks/hooks.json", mcpServers: "./.mcp.json" }));
  write(join(packageRoot, "skills", "native-proof-skill", "SKILL.md"), "---\nname: native-proof-skill\ndescription: Native fixture skill\n---\nUse the local fixture tool.\n");
  write(join(packageRoot, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `/usr/bin/touch ${JSON.stringify(hookOutput)}` }] }] } }));
  write(join(packageRoot, ".mcp.json"), JSON.stringify({ mcpServers: { native_proof: { command: process.execPath, args: ["server.js"], cwd: ".", env_vars: ["CODEX_HOME"] } } }));
  write(join(packageRoot, "server.js"), `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{try{const r=JSON.parse(line);if(!('id'in r))return;let result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'native-proof',version:'1'}}:r.method==='tools/list'?{tools:[{name:'fixture_actor',description:'fixture actor',inputSchema:{type:'object',properties:{}}}]}:r.method==='tools/call'?{content:[{type:'text',text:process.env.CODEX_HOME}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')}catch{}});`);
  write(join(home, "config.toml"), `[features]\ntool_suggest=false\n[mcp_servers.owned_stdio]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(packageRoot, "server.js"))}]\nenabled=false\n`);
  const sourceBefore = sha(join(source, "config.toml")), packageBefore = sha(join(packageRoot, "hooks", "hooks.json"));
  const ledger = new SharedPluginLedgerStoreV1({ root: join(root, "library"), sourceHome: source, secret: Buffer.alloc(32, 6), localLibrary: true,
    authority: { sourceAccountId: account, sourceRootIdentity: "fixture-source", modeFingerprint: "fixture-mode" } });
  const session = { actor: account, authIdentity: "fixture-auth", stamp: "fixture-owned-child" };
  await hydrateOfficialSharedPluginLedgerV1({ ledger, sourceHome: source, session: () => session, authorize: () => true, localLibrary: true,
    readProvider: async () => { throw new Error("local publication needs no provider metadata"); } });
  ledger.project({ stateRoot, account: { opaqueAccountId: account, codexHome: home }, authorize: () => true, writeEvidence: { accountChildAbsent: true } });
  const key = join(root, "fixture.key"), certificate = join(root, "fixture.crt"), opensslConfig = join(root, "fixture.cnf");
  const fixtureAuthorityKey = join(root, "fixture-authority.key"), fixtureAuthority = join(root, "fixture-authority.crt"), fixtureRequest = join(root, "fixture.csr");
  write(opensslConfig, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Local fixture authority\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n");
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-config", opensslConfig, "-keyout", fixtureAuthorityKey, "-out", fixtureAuthority], { stdio: "ignore" });
  write(opensslConfig, "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Local fixture\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  execFileSync("/usr/bin/openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-config", opensslConfig, "-keyout", key, "-out", fixtureRequest], { stdio: "ignore" });
  execFileSync("/usr/bin/openssl", ["x509", "-req", "-in", fixtureRequest, "-CA", fixtureAuthority, "-CAkey", fixtureAuthorityKey, "-CAcreateserial", "-days", "1", "-sha256", "-extfile", opensslConfig, "-extensions", "ext", "-out", certificate], { stdio: "ignore" });
  const sockets = new Set<Duplex>(), paths: string[] = [], providerPaths: string[] = [], modelRequests: string[] = [];
  const providerDiagnostics: unknown[] = [], requestDiagnostics: unknown[] = [];
  let stderr = "", complete = false, effectiveConfig: unknown;
  const redact = (value: string) => value.replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .replace(/\b(Bearer|Basic)\s+[^\s\"\\]+/gi, "$1 [redacted]")
    .replace(/(\"(?:accessToken|access_token|refreshToken|refresh_token|id_token|authorization)\"\s*:\s*)\"[^\"]*\"/gi, '$1"[redacted]"');
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    paths.push((request.url ?? "").split("?")[0]!); response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url?.endsWith("/responses")) {
      const chunks: Buffer[] = []; request.on("data", bytes => { chunks.push(bytes); }); request.on("end", () => {
        const bytes = Buffer.concat(chunks), encoding = request.headers["content-encoding"];
        let body: Buffer;
        try { body = encoding === "zstd" ? zstdDecompressSync(bytes) : encoding === "gzip" ? gunzipSync(bytes) : encoding === "deflate" ? inflateSync(bytes) : bytes; }
        catch { requestDiagnostics.push({ path: request.url, encoding, decodeError: true, bytes: bytes.length }); response.writeHead(400); response.end(); return; }
        const text = body.toString("utf8"); modelRequests.push(text);
        requestDiagnostics.push({ path: request.url, encoding, bytes: bytes.length, decodedBytes: body.length, recommended: text.includes("recommended-proof") });
        response.setHeader("content-type", "text/event-stream");
        response.end([{ type: "response.created", response: { id: "fixture-response" } }, { type: "response.completed", response: { id: "fixture-response", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
      });
    }
    else if (request.url?.includes("/accounts/check")) response.end(JSON.stringify({ accounts: [{ id: "fixture-account", workspace_backend_origin: process.env.TWEAKERS_NATIVE_ROUTING_FIXTURE === "1" ? "NO_CONSTRAINT" : `https://127.0.0.1:${(server.address() as { port: number }).port}`, account_routing_override: "NO_CONSTRAINT" }], default_account_id: "fixture-account" }));
    else if (request.url?.includes("/models")) response.end('{"models":[]}');
    else if (request.url?.includes("/ps/mcp")) {
      if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
      let body = ""; request.on("data", bytes => { body += bytes; }); request.on("end", () => {
        try {
          const r = JSON.parse(body);
          if (r.id === undefined) { response.writeHead(202); response.end(); return; }
          response.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: r.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture-empty-apps", version: "1" } } : { tools: [] } }));
        } catch { response.writeHead(400); response.end(); }
      });
    }
    else response.end("{}");
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  // Match the official recommendation integration test's HTTP mock provider.
  // Removed WebSocket feature flags do not disable the stock provider's WS
  // capability. A separate local provider also avoids real model discovery.
  write(join(home, "config.toml"), `model="fixture-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local fixture provider"\nbase_url="https://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nsupports_websockets=false\n[features]\ntool_suggest=false\n[mcp_servers.owned_stdio]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(packageRoot, "server.js"))}]\nenabled=false\n`);
  const routingOnly = process.env.TWEAKERS_NATIVE_ROUTING_FIXTURE === "1";
  if (routingOnly) write(join(home, "config.toml"), `model="gpt-6.1-sol"\n[features]\ntool_suggest=false\n[mcp_servers.owned_stdio]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(packageRoot, "server.js"))}]\nenabled=false\n`);
  let service: Awaited<ReturnType<typeof prepareOfficialPluginAccountServiceV1>> | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let childClosed = true;
  const notifications: Array<{ method: string; params: any }> = [];
  t.after(async () => {
    if (child && !childClosed) {
      const exit = new Promise<void>(resolve => child!.once("close", () => resolve()));
      child.kill("SIGTERM"); await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 5000))]);
      if (!childClosed) { child.kill("SIGKILL"); await exit; }
    }
    if (!complete) {
      const evidence = realpathSync(mkdtempSync(join(tmpdir(), "native-plugin-failure-evidence-"))); chmodSync(evidence, 0o700);
      const payload = { suppliedHash, paths, providerPaths, providerDiagnostics, requestDiagnostics, effectiveConfig,
        notifications: notifications.slice(-128), stderr: stderr.slice(-65_536), decodedModelRequests: modelRequests.slice(-2).map(body => body.slice(0, 262_144)) };
      writeFileSync(join(evidence, "diagnostics.json"), redact(JSON.stringify(payload, null, 2)).slice(0, 1_048_576), { mode: 0o600 });
      t.diagnostic(`Retained bounded redacted native fixture diagnostics: ${evidence}/diagnostics.json`);
    }
    if (service) assert.equal(await service.close(), true);
    ledger.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(sha(backend), suppliedHash); assert.equal(sha(join(source, "config.toml")), sourceBefore); assert.equal(sha(join(packageRoot, "hooks", "hooks.json")), packageBefore);
    const writable = (path: string): void => { const stat = lstatSync(path); if (stat.isSymbolicLink()) return; chmodSync(path, 0o700); if (stat.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name)); };
    writable(root); rmSync(root, { recursive: true, force: true });
  });
  service = await prepareOfficialPluginAccountServiceV1({ root, upstreamBaseUrl: `https://127.0.0.1:${address.port}/backend-api`, ledger, session: () => session,
    authorizeHeaders: () => true, policy: () => true, caEnvironment: { CODEX_CA_CERTIFICATE: fixtureAuthority },
    readProvider: async (path, query) => { providerPaths.push(path); const reply = ({ status: 200, value: path === "/ps/plugins/suggested/codex" ? { enabled: true, plugins: [{ id: "plugins_installed_fixture", name: "native-proof", display_name: "Installed" }, { id: "plugins_genuine_fixture", name: "recommended-proof", display_name: "Genuine recommendation" }] }
      : path === "/plugins/featured" ? ["recommended-proof@openai-curated-remote"]
      : path === "/ps/plugins/list" ? { plugins: [{ id: "plugins_genuine_fixture", name: "recommended-proof", scope: "GLOBAL", status: "ENABLED", installation_policy: "AVAILABLE", installation_policy_source: "WORKSPACE_SETTING", authentication_policy: "ON_USE", must_show_installation_interstitial: false, release: { version: "1.0.0", display_name: "Genuine recommendation", description: "Fixture recommendation", interface: {}, app_ids: [], keywords: [], skills: [] } }], pagination: { limit: 50, next_page_token: null } } : { plugins: [], pagination: { limit: 50, next_page_token: null } } });
      providerDiagnostics.push({ path, query: [...query.entries()], status: reply.status, value: reply.value }); return reply; } });
  const snapshot = readOfficialInstalledPluginSnapshotV1(source), inventory = { schema_version: 1 as const, native_base_root: source, plugins: snapshot.plugins };
  const plan = officialBundledAccountPlanV1({ sourceHome: source, settingsHome: source, accountHome: home,
    args: ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"', "-c", "features.shell_snapshot=false", "-c", "features.tool_suggest=false"], inventory, localLibrary: true });
  assert.deepEqual(plan.withheldPlugins, {});
  child = spawn(backend, [...plan.args, "-c", `chatgpt_base_url=${JSON.stringify(service.baseUrl)}`], { cwd: project,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, CODEX_HOME: home, CODEX_SQLITE_HOME: home, ...service.childEnvironment }, stdio: ["pipe", "pipe", "pipe"] });
  childClosed = false; child.once("close", () => { childClosed = true; });
  child.stderr.on("data", bytes => { stderr = (stderr + redact(bytes.toString("utf8"))).slice(-65_536); });
  const pending = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 0;
  createInterface({ input: child.stdout }).on("line", line => {
    let value: any; try { value = JSON.parse(line); } catch { return; }
    if (typeof value.id === "number" && pending.has(value.id)) { const p = pending.get(value.id)!; pending.delete(value.id); clearTimeout(p.timer); value.error ? p.reject(new Error(`Native fixture RPC failed: ${p.method}: ${JSON.stringify(value.error)}; paths=${JSON.stringify(paths)}; pluginReads=${JSON.stringify(providerPaths)}`)) : p.resolve(value.result); }
    else if (value.method && value.id !== undefined) child!.stdin.write(JSON.stringify({ id: value.id, result: { decision: "decline" } }) + "\n");
    else if (typeof value.method === "string") notifications.push(value);
  });
  const rpc = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native fixture RPC timed out: ${method}`)); }, 20_000);
    pending.set(id, { method, resolve, reject, timer }); child!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  t.after(() => { for (const p of pending.values()) clearTimeout(p.timer); });
  await rpc("initialize", { clientInfo: { name: "codex_desktop", title: "Codex Desktop", version: "1" }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } });
  child.stdin.write('{"method":"initialized","params":{}}\n');
  const effective = await rpc("config/read", { includeLayers: true });
  effectiveConfig = effective.config;
  assert.equal(effective.config.features.tool_suggest, false, "owned disabled features must survive ROOT overrides");
  assert.equal(effective.config.features.shell_snapshot, false, "earlier CLI feature siblings must survive ROOT overrides");
  assert.equal(effective.config.mcp_servers.owned_stdio.command, process.execPath, "owned MCP definitions must survive shared defaults");
  assert.equal(effective.config.mcp_servers.owned_stdio.enabled, false, "owned MCP disabled policy must survive shared defaults");
  assert.equal(officialPluginEffectiveConfigMatchesV1(effective, service.baseUrl), true, "effective managed routing must be checked before login");
  const fixtureJwt = [Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url"), Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
    iss: "https://auth.openai.com", sub: "fixture-user", email: "fixture@example.invalid", "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_user_id: "fixture-user", chatgpt_plan_type: "plus" } })).toString("base64url"), Buffer.from("fixture-not-a-provider-signature").toString("base64url")].join(".");
  await rpc("account/login/start", { type: "chatgptAuthTokens", accessToken: fixtureJwt, chatgptAccountId: "fixture-account", chatgptPlanType: "plus" });
  // Native login clears recommendation generations after its RPC response.
  for (let n = 0; n < 500 && !notifications.some(row => row.method === "account/login/completed"); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(notifications.some(row => row.method === "account/login/completed" && row.params.success === true), "native login completion must settle before thread startup");
  const privateAccount = await rpc("account/read", { refreshToken: false });
  if (routingOnly) {
    assert.equal(privateAccount.workspaceRouting?.backendOrigin, new URL(service.baseUrl).origin,
      `desktop discovery routing: ${JSON.stringify(privateAccount)}`);
    const helperHome = join(root, "auth-helper");
    write(join(helperHome, "config.toml"), `chatgpt_base_url="https://127.0.0.1:${address.port}/backend-api"\n`);
    const helper = new BrokerProcessChild(account, spawn(backend, ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"'], {
      cwd: helperHome, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, CODEX_HOME: helperHome,
        CODEX_SQLITE_HOME: helperHome, CODEX_CA_CERTIFICATE: fixtureAuthority }, stdio: ["pipe", "pipe", "ignore"],
    }), () => {}, () => {});
    try {
      assert.equal(await helper.initialize({ clientInfo: { name: "codex_desktop", version: "1" }, capabilities: { experimentalApi: true } }, null), true);
      const login = await helper.requestPrivate("account/login/start", { type: "chatgptAuthTokens", accessToken: fixtureJwt,
        chatgptAccountId: "fixture-account", chatgptPlanType: "plus" });
      assert.ok(login && !login.error);
      const publicAccount = await helper.requestPrivate("account/read", { refreshToken: false });
      assert.ok(publicAccount && !publicAccount.error);
      const routing = (publicAccount.result as any).workspaceRouting;
      assert.deepEqual(routing, { chatgptAccountId: "fixture-account", backendOrigin: `https://127.0.0.1:${address.port}`, accountRoutingOverride: "NO_CONSTRAINT" });
      assert.notEqual(routing.backendOrigin, privateAccount.workspaceRouting.backendOrigin);
    } finally { assert.equal(await helper.terminateAndWait(), true); }
    complete = true; return;
  }
  const discovered = await rpc("plugin/installed", { cwds: [project] });
  const skills = await rpc("skills/list", { cwds: [project], forceReload: true });
  assert.ok(skills.data.flatMap((row: any) => row.skills).some((row: any) => row.pluginId === aliasId && row.name.endsWith("native-proof-skill")), JSON.stringify({ features: effective.config.features,
    plugins: effective.config.plugins, discovery: discovered, skillNames: skills.data.flatMap((row: any) => row.skills).map((row: any) => ({ name: row.name, pluginId: row.pluginId })), errors: skills.data.map((row: any) => row.errors) }));
  const hooks = await rpc("hooks/list", { cwds: [project] });
  const hook = hooks.data.flatMap((row: any) => row.hooks).find((row: any) => row.pluginId === aliasId && row.eventName === "sessionStart");
  assert.ok(hook, JSON.stringify({ hookDiscovery: hooks })); assert.equal(hook.trustStatus, "untrusted");
  assert.equal(existsSync(hookOutput), false);
  const publicHook = (officialCanonicalPluginResponseV1({ hook }, inventory) as any).hook;
  assert.equal(publicHook.pluginId, canonicalId); assert.equal(publicHook.currentHash, hook.currentHash); assert.equal(publicHook.sourcePath, hook.sourcePath);
  await rpc("config/value/write", { keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace", filePath: null, expectedVersion: null });
  const trusted = await rpc("hooks/list", { cwds: [project] });
  assert.equal(trusted.data.flatMap((row: any) => row.hooks).find((row: any) => row.key === hook.key).trustStatus, "trusted");
  const plugins = await rpc("plugin/installed", { cwds: [project] });
  assert.match(JSON.stringify(plugins), new RegExp(aliasId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const recs = await service.interceptHttp("GET", "/ps/plugins/suggested/codex", new URLSearchParams(), Buffer.alloc(0));
  assert.deepEqual((recs.value as any).plugins.map((row: any) => row.id), ["plugins_genuine_fixture"]);
  const catalogue = await rpc("plugin/list", { cwds: [project], forceRefetch: true });
  assert.ok(catalogue.marketplaces.flatMap((row: any) => row.plugins).some((row: any) => row.id === "recommended-proof@openai-curated-remote" && row.remotePluginId === "plugins_genuine_fixture"), JSON.stringify({ catalogue, providerPaths, features: effective.config.features, account: await rpc("account/read", { refreshToken: false }) }));
  const thread = await rpc("thread/start", { cwd: project, approvalPolicy: "never", sandbox: "danger-full-access", config: { "features.codex_hooks": true } });
  assert.ok(thread.thread.id);
  await rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Complete this local fixture." }] });
  for (let n = 0; n < 250 && !existsSync(hookOutput); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(hookOutput), true, "approved native SessionStart hook must execute in the isolated home");
  const status = await rpc("mcpServerStatus/list", { threadId: thread.thread.id, limit: 100, detail: "full" });
  assert.match(JSON.stringify(status), /fixture_actor/);
  const serverRow = status.data.find((row: any) => JSON.stringify(row).includes("fixture_actor"));
  assert.ok(serverRow?.name);
  assert.equal(serverRow.runtimeStatus, "connected");
  const call = await rpc("mcpServer/tool/call", { threadId: thread.thread.id, server: serverRow.name, tool: "fixture_actor", arguments: {} });
  assert.notEqual(call.isError, true); assert.match(JSON.stringify(call), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (let n = 0; n < 500 && !notifications.some(row => ["turn/completed", "error"].includes(row.method)); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(modelRequests.length, JSON.stringify({ paths, providerPaths, turns: notifications.filter(row => ["turn/completed", "error"].includes(row.method)) }));
  assert.ok(modelRequests.some(request => request.includes("recommended-proof")), "the native model request must preserve genuine recommendations");
  assert.ok(modelRequests.every(request => !request.includes("plugins_installed_fixture")), "installed source recommendations must remain deduplicated");
  assert.ok(notifications.some(row => row.method === "turn/completed" && row.params.turn.status === "completed"), "the real native fixture turn must complete");
  assert.equal(/failed to refresh available models:.*https:\/\/chatgpt\.com/.test(stderr), false, "the fixture must not use real model discovery");
  assert.ok(existsSync(join(home, "plugins", "cache", aliasId.split("@")[1]!, "native-proof", "1.0.0", "skills", "native-proof-skill", "SKILL.md")));
  complete = true;
});

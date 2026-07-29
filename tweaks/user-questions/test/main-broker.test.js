"use strict";

const assert = require("node:assert/strict");
const {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const net = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const {
  BROKER_METADATA_FILE,
  BrokerProtocolError,
  connectBroker,
  createProtocolPeer,
} = require("../broker-protocol");
const { ROUTE_HMAC_KEY_FILE, createMainBroker } = require("../main-broker");

const ROUTE = Object.freeze({
  webContentsId: 73,
  hostId: "host-41",
  conversationId: "conversation-29",
});

test("authenticated broker binds one-use claims to the exact renderer and cleans every endpoint", async (t) => {
  if (process.platform === "win32") return t.skip("Unix-domain broker contract");
  const root = mkdtempSync(join(tmpdir(), "uq-main-broker-"));
  const dataDir = join(root, "data");
  const socketPath = join(root, "broker.sock");
  const diagnostics = [];
  const deliveries = [];
  const broker = createMainBroker({
    dataDir,
    tweakId: "co.tweakers.user-questions",
    permissions: ["filesystem", "ipc", "network"],
    socketPath,
    requestTimeoutMs: 500,
    authTimeoutMs: 500,
    registrationTimeoutMs: 500,
    onDiagnostic: (record) => diagnostics.push(record),
    sendToRenderer: (webContentsId, channel, ...args) => {
      deliveries.push({ webContentsId, channel, args });
      return webContentsId === ROUTE.webContentsId;
    },
  });
  t.after(async () => broker.stop());

  const endpoint = await broker.start();
  assert.equal(statSync(endpoint.metadataPath).mode & 0o777, 0o600);
  assert.equal(statSync(endpoint.socketPath).mode & 0o777, 0o600);
  const metadata = JSON.parse(readFileSync(join(dataDir, BROKER_METADATA_FILE), "utf8"));
  assert.equal(metadata.socketPath, socketPath);
  assert.match(metadata.secret, /^[a-f0-9]{64}$/);

  const client = await connectBroker({
    dataDir,
    tweakId: "co.tweakers.user-questions",
    timeoutMs: 500,
  });
  t.after(() => client.close());
  const sentinel = "QUESTION_ANSWER_SCHEMA_DO_NOT_LOG_e96b";
  client.setRequestHandler((method, payload) => {
    if (method === "claimed") return { phase: "question", revision: 0 };
    if (method === "round.action") return { method, payload };
    throw new BrokerProtocolError("method_unsupported");
  });
  await client.register("nonce-one-use-123");

  const claim = await broker.claim("nonce-one-use-123", ROUTE);
  assert.equal(claim.status, "claimed");
  assert.match(claim.claimToken, /^[a-f0-9]{64}$/);
  assert.match(claim.routeHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(claim.initial, { phase: "question", revision: 0 });
  assert.equal(broker.snapshot().activeClaims, 1);

  await assert.rejects(
    broker.claim("nonce-one-use-123", ROUTE),
    (error) => error instanceof BrokerProtocolError && error.code === "nonce_replayed",
  );
  await assert.rejects(
    broker.request(claim.claimToken, { ...ROUTE, webContentsId: 74 }, "round.action", {}),
    (error) => error instanceof BrokerProtocolError && error.code === "renderer_mismatch",
  );
  assert.equal(broker.observeRoute(claim.claimToken, ROUTE), true, "a spoof must not invalidate the owner");

  const response = await broker.request(
    claim.claimToken,
    ROUTE,
    "round.action",
    { revision: 0, opaqueTestContent: sentinel },
  );
  assert.deepEqual(response, {
    method: "round.action",
    payload: { revision: 0, opaqueTestContent: sentinel },
  });
  assert.equal(broker.deliver(claim.claimToken, ROUTE, "round.changed", { revision: 1 }), true);
  assert.deepEqual(deliveries, [{
    webContentsId: 73,
    channel: "round.changed",
    args: [{ revision: 1 }],
  }]);

  assert.equal(
    broker.observeRoute(claim.claimToken, { ...ROUTE, hostId: "host-drifted" }),
    false,
  );
  assert.equal(broker.observeRoute(claim.claimToken, ROUTE), false, "route-invalidated claims never revive");
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(sentinel));
  assert.equal(diagnostics.every((record) => record.contentRedacted === true), true);

  client.close();
  await waitFor(() => broker.snapshot().sessions === 0);
  assert.equal(broker.snapshot().sessions, 0);
  await broker.stop();
  assert.equal(statMissing(endpoint.metadataPath), true);
  assert.equal(statMissing(endpoint.socketPath), true);
});

test("wrong tokens, registration replay, and claim timeouts fail closed", async (t) => {
  if (process.platform === "win32") return t.skip("Unix-domain broker contract");
  const root = mkdtempSync(join(tmpdir(), "uq-main-broker-reject-"));
  const dataDir = join(root, "data");
  const broker = createMainBroker({
    dataDir,
    tweakId: "co.tweakers.user-questions",
    permissions: ["ipc", "network"],
    socketPath: join(root, "broker.sock"),
    requestTimeoutMs: 250,
    authTimeoutMs: 250,
    registrationTimeoutMs: 60,
    nonceRetentionMs: 500,
    sendToRenderer: () => true,
  });
  t.after(async () => broker.stop());
  const endpoint = await broker.start();

  const wrongSocket = await openSocket(endpoint.socketPath);
  const wrongPeer = createProtocolPeer(wrongSocket, { requestTimeoutMs: 250 });
  await assert.rejects(
    wrongPeer.request("authenticate", { secret: "0".repeat(64) }),
    (error) => error instanceof BrokerProtocolError && error.code === "auth_failed",
  );
  wrongPeer.close();

  const first = await connectBroker({ dataDir, tweakId: "co.tweakers.user-questions", timeoutMs: 250 });
  first.setRequestHandler(() => ({}));
  await first.register("nonce-replay-1234");
  const second = await connectBroker({ dataDir, tweakId: "co.tweakers.user-questions", timeoutMs: 250 });
  t.after(() => first.close());
  t.after(() => second.close());
  await assert.rejects(
    second.register("nonce-replay-1234"),
    (error) => error instanceof BrokerProtocolError && error.code === "nonce_replayed",
  );

  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(broker.snapshot().pendingRegistrations, 0);
  await assert.rejects(
    broker.claim("nonce-replay-1234", ROUTE),
    (error) => error instanceof BrokerProtocolError && error.code === "nonce_replayed",
  );
});

test("route identity persists across broker instances but remains isolated by data directory", async (t) => {
  if (process.platform === "win32") return t.skip("Unix-domain broker contract");
  const root = mkdtempSync(join(tmpdir(), "uq-main-broker-route-key-"));
  const dataDir = join(root, "data");
  const otherDataDir = join(root, "other-data");
  const firstBroker = testBroker(dataDir, join(root, "first.sock"));
  const secondBroker = testBroker(dataDir, join(root, "second.sock"));
  const otherBroker = testBroker(otherDataDir, join(root, "other.sock"));
  t.after(async () => {
    await Promise.all([firstBroker.stop(), secondBroker.stop(), otherBroker.stop()]);
  });

  await firstBroker.start();
  const firstAuthSecret = readMetadata(dataDir).secret;
  const firstClaim = await claimRoute(firstBroker, dataDir, "nonce-route-key-first");
  await firstBroker.stop();

  await secondBroker.start();
  const secondAuthSecret = readMetadata(dataDir).secret;
  const secondClaim = await claimRoute(secondBroker, dataDir, "nonce-route-key-second");
  assert.notEqual(secondAuthSecret, firstAuthSecret, "socket authentication must remain ephemeral");
  assert.equal(secondClaim.routeHash, firstClaim.routeHash, "same install route identity must persist");

  const keyPath = join(dataDir, ROUTE_HMAC_KEY_FILE);
  const persistedKey = readFileSync(keyPath, "utf8");
  const keyStat = lstatSync(keyPath);
  assert.equal(keyStat.isFile(), true);
  assert.equal(keyStat.isSymbolicLink(), false);
  assert.equal(keyStat.mode & 0o777, 0o600);
  assert.match(persistedKey, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(keyPath, "utf8"), persistedKey, "broker restart must preserve the install key");
  await secondBroker.stop();

  await otherBroker.start();
  const otherClaim = await claimRoute(otherBroker, otherDataDir, "nonce-route-key-other");
  assert.notEqual(otherClaim.routeHash, firstClaim.routeHash, "another install must have another identity");
});

test("route identity key rejects corruption, unsafe permissions, and symlinks without logging content", async (t) => {
  if (process.platform === "win32") return t.skip("Unix-domain broker contract");
  const root = mkdtempSync(join(tmpdir(), "uq-rk-reject-"));
  const sentinel = "ROUTE_KEY_CONTENT_DO_NOT_LOG_84c2";
  const cases = [
    {
      name: "corrupt",
      prepare(keyPath) {
        writeFileSync(keyPath, sentinel, { mode: 0o600 });
      },
    },
    {
      name: "wrong-mode",
      prepare(keyPath) {
        writeFileSync(keyPath, "a".repeat(64), { mode: 0o600 });
        chmodSync(keyPath, 0o644);
      },
    },
    {
      name: "symlink",
      prepare(keyPath, dataDir) {
        const target = join(dataDir, "route-key-target");
        writeFileSync(target, "b".repeat(64), { mode: 0o600 });
        symlinkSync(target, keyPath);
      },
    },
  ];

  for (const scenario of cases) {
    const dataDir = join(root, scenario.name);
    mkdirSync(dataDir, { mode: 0o700 });
    scenario.prepare(join(dataDir, ROUTE_HMAC_KEY_FILE), dataDir);
    const diagnostics = [];
    const broker = testBroker(dataDir, join(root, `${scenario.name}.sock`), diagnostics);
    t.after(async () => broker.stop());
    await assert.rejects(
      broker.start(),
      (error) => error instanceof BrokerProtocolError
        && error.code === "data_dir_invalid"
        && !String(error).includes(sentinel),
      `${scenario.name} route key must fail closed`,
    );
    assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(sentinel));
  }

  const ambiguousDataDir = join(root, "owner-ambiguous");
  mkdirSync(ambiguousDataDir, { mode: 0o700 });
  writeFileSync(
    join(ambiguousDataDir, ROUTE_HMAC_KEY_FILE),
    "c".repeat(64),
    { mode: 0o600 },
  );
  const ambiguousBroker = testBroker(ambiguousDataDir, join(root, "owner.sock"));
  t.after(async () => ambiguousBroker.stop());
  const originalGetuid = process.getuid;
  process.getuid = undefined;
  try {
    await assert.rejects(
      ambiguousBroker.start(),
      (error) => error instanceof BrokerProtocolError && error.code === "data_dir_owner_invalid",
      "an unverifiable owner must fail closed",
    );
  } finally {
    process.getuid = originalGetuid;
  }
});

function openSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function testBroker(dataDir, socketPath, diagnostics = []) {
  return createMainBroker({
    dataDir,
    tweakId: "co.tweakers.user-questions",
    permissions: ["ipc", "network"],
    socketPath,
    requestTimeoutMs: 500,
    authTimeoutMs: 500,
    registrationTimeoutMs: 500,
    onDiagnostic: (record) => diagnostics.push(record),
    sendToRenderer: () => true,
  });
}

function readMetadata(dataDir) {
  return JSON.parse(readFileSync(join(dataDir, BROKER_METADATA_FILE), "utf8"));
}

async function claimRoute(broker, dataDir, nonce) {
  const client = await connectBroker({
    dataDir,
    tweakId: "co.tweakers.user-questions",
    timeoutMs: 500,
  });
  client.setRequestHandler((method) => {
    if (method === "claimed") return { phase: "question", revision: 0 };
    throw new BrokerProtocolError("method_unsupported");
  });
  try {
    await client.register(nonce);
    return await broker.claim(nonce, ROUTE);
  } finally {
    client.close();
  }
}

function statMissing(filePath) {
  try { statSync(filePath); return false; }
  catch (error) { return error?.code === "ENOENT"; }
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for broker cleanup");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

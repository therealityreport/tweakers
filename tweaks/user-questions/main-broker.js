"use strict";

const {
  chmodSync,
  closeSync,
  constants: fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { createHash, createHmac, randomBytes, randomUUID } = require("node:crypto");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  BROKER_DEFAULT_TIMEOUT_MS,
  BROKER_METADATA_FILE,
  BROKER_PROTOCOL_VERSION,
  BrokerProtocolError,
  assertBrokerPermissions,
  assertNonce,
  createProtocolPeer,
  redactedDiagnostic,
  requestFrame,
  secureEqualString,
} = require("./broker-protocol");

const DEFAULT_AUTH_TIMEOUT_MS = 2_000;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 15_000;
const DEFAULT_NONCE_RETENTION_MS = 10 * 60_000;
const MAX_CONNECTIONS = 32;
const MAX_TRACKED_NONCES = 4_096;
const MAX_UNIX_SOCKET_PATH_BYTES = 96;
const ROUTE_PART_MAX_LENGTH = 512;
const ROUTE_HMAC_KEY_FILE = "user-questions-route-hmac.v1.key";
const ROUTE_HMAC_KEY_BYTES = 32;
const ROUTE_HMAC_KEY_HEX_LENGTH = ROUTE_HMAC_KEY_BYTES * 2;
const ENHANCEMENT_PROTOCOL_VERSION = 1;
const ENHANCEMENT_MAX_FRAME_BYTES = 16 * 1024;
const ENHANCEMENT_SOCKET_ENV = "USER_QUESTIONS_ENHANCEMENT_SOCKET";
const ENHANCEMENT_CLAIM_TTL_MS = 30_000;
const ENHANCEMENT_DELIVERY_TIMEOUT_MS = 5 * 60_000;
const MAX_ENHANCEMENT_SESSIONS = 32;

function createMainBroker(options = {}) {
  assertBrokerPermissions(options.permissions);
  const dataDir = requireAbsolutePath(options.dataDir, "data_dir_invalid");
  const tweakId = requireTweakId(options.tweakId);
  const sendToRenderer = options.sendToRenderer;
  if (typeof sendToRenderer !== "function") throw new BrokerProtocolError("renderer_delivery_missing");

  const requestTimeoutMs = boundedTimeout(options.requestTimeoutMs, BROKER_DEFAULT_TIMEOUT_MS);
  const authTimeoutMs = boundedTimeout(options.authTimeoutMs, DEFAULT_AUTH_TIMEOUT_MS);
  const registrationTimeoutMs = boundedTimeout(
    options.registrationTimeoutMs,
    DEFAULT_REGISTRATION_TIMEOUT_MS,
  );
  const nonceRetentionMs = boundedTimeout(options.nonceRetentionMs, DEFAULT_NONCE_RETENTION_MS, 60 * 60_000);
  const enhancementClaimTtlMs = boundedTimeout(
    options.enhancementClaimTtlMs,
    ENHANCEMENT_CLAIM_TTL_MS,
    5 * 60_000,
  );
  const enhancementDeliveryTimeoutMs = boundedTimeout(
    options.enhancementDeliveryTimeoutMs,
    ENHANCEMENT_DELIVERY_TIMEOUT_MS,
    10 * 60_000,
  );
  const secret = randomBytes(32).toString("hex");
  const metadataPath = path.join(dataDir, BROKER_METADATA_FILE);
  const socketPath = selectSocketPath(dataDir, options.socketPath);
  let enhancementSocketPath = null;
  let enhancementPathError = null;
  try {
    enhancementSocketPath = resolveEnhancementSocketPath(options.enhancementSocketPath);
  } catch (error) {
    enhancementPathError = error;
  }
  const sessions = new Set();
  const pendingByNonce = new Map();
  const consumedNonces = new Map();
  const claims = new Map();
  const enhancementRenderers = new Set();
  const enhancementSessions = new Map();
  let server = null;
  let enhancementServer = null;
  let ownedEnhancementSocket = null;
  let routeHmacKey = null;
  let started = false;
  let stopping = false;

  async function start() {
    if (started) return endpoint();
    if (stopping) throw new BrokerProtocolError("broker_stopping");
    preparePrivateDataDirectory(dataDir);
    routeHmacKey = loadOrCreateRouteHmacKey(dataDir);
    server = net.createServer(onConnection);
    server.maxConnections = MAX_CONNECTIONS;
    await listen(server, socketPath);
    try {
      chmodSync(socketPath, 0o600);
      if (enhancementSocketPath) {
        try {
          assertEnhancementSocketAvailable(enhancementSocketPath);
          enhancementServer = net.createServer(onEnhancementConnection);
          enhancementServer.maxConnections = MAX_CONNECTIONS;
          await listen(enhancementServer, enhancementSocketPath);
          chmodSync(enhancementSocketPath, 0o600);
          ownedEnhancementSocket = socketIdentity(enhancementSocketPath);
        } catch (error) {
          const unavailableServer = enhancementServer;
          enhancementServer = null;
          if (unavailableServer) await closeServer(unavailableServer);
          removeOwnedEnhancementSocket();
          enhancementSocketPath = null;
          diagnose("enhancement_unavailable", errorCode(error));
        }
      } else if (enhancementPathError) {
        diagnose("enhancement_unavailable", errorCode(enhancementPathError));
      }
      writeMetadata(metadataPath, { version: BROKER_PROTOCOL_VERSION, tweakId, socketPath, secret });
    } catch (error) {
      const activeEnhancementServer = enhancementServer;
      enhancementServer = null;
      if (activeEnhancementServer) await closeServer(activeEnhancementServer);
      await closeServer(server);
      server = null;
      rmSync(socketPath, { force: true });
      removeOwnedEnhancementSocket();
      throw error;
    }
    started = true;
    diagnose("broker_started");
    return endpoint();
  }

  function onConnection(socket) {
    if (stopping || sessions.size >= MAX_CONNECTIONS) {
      socket.destroy();
      diagnose("connection_rejected", "broker_capacity");
      return;
    }
    const session = {
      socket,
      peer: null,
      authenticated: false,
      nonce: null,
      registrationTimer: null,
      authTimer: null,
      closed: false,
    };
    sessions.add(session);
    session.peer = createProtocolPeer(socket, {
      requestTimeoutMs,
      onRequest: (method, payload) => handleSessionRequest(session, method, payload),
      onDiagnostic: (record) => diagnose(record.event, record.code),
      onClose: () => cleanupSession(session),
    });
    session.authTimer = setTimeout(() => {
      diagnose("authentication_timeout", "auth_timeout");
      session.peer.close();
    }, authTimeoutMs);
    session.authTimer.unref?.();
  }

  function onEnhancementConnection(socket) {
    let buffered = Buffer.alloc(0);
    let handled = false;
    let pendingSessionId = null;
    let timeout = setTimeout(() => socket.destroy(), DEFAULT_AUTH_TIMEOUT_MS);
    timeout.unref?.();

    const stopTimer = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
    };
    const fail = () => {
      stopTimer();
      socket.destroy();
    };
    socket.on("error", stopTimer);
    socket.on("close", () => {
      stopTimer();
      if (pendingSessionId) abandonEnhancementDelivery(pendingSessionId, socket);
    });
    socket.on("data", (chunk) => {
      if (handled) return;
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffered.byteLength > ENHANCEMENT_MAX_FRAME_BYTES) return fail();
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
      } catch {
        return fail();
      }
      if (request?.type === "claim") {
        try {
          socket.end(`${JSON.stringify(claimEnhancement(request))}\n`);
        } catch {
          fail();
        }
        return;
      }
      if (request?.type !== "deliver") return fail();
      stopTimer();
      timeout = setTimeout(() => fail(), enhancementDeliveryTimeoutMs);
      timeout.unref?.();
      let pending;
      try {
        pending = deliverEnhancement(request, socket);
        pendingSessionId = request.session_id;
      } catch {
        return fail();
      }
      Promise.resolve(pending).then(
        (response) => {
          pendingSessionId = null;
          stopTimer();
          socket.end(`${JSON.stringify(response)}\n`);
        },
        () => fail(),
      );
    });
  }

  async function handleSessionRequest(session, method, payload) {
    if (!session.authenticated) {
      if (method !== "authenticate") throw new BrokerProtocolError("auth_required");
      const auth = exactPayload(payload, ["secret"]);
      if (!secureEqualString(auth.secret, secret)) {
        diagnose("authentication_rejected", "auth_failed");
        setImmediate(() => session.peer.close());
        throw new BrokerProtocolError("auth_failed");
      }
      session.authenticated = true;
      clearTimer(session.authTimer);
      session.authTimer = null;
      diagnose("authenticated");
      return { authenticated: true, version: BROKER_PROTOCOL_VERSION };
    }
    if (method === "authenticate") throw new BrokerProtocolError("auth_replayed");
    if (method !== "register") throw new BrokerProtocolError("method_unsupported");
    const registration = exactPayload(payload, ["nonce"]);
    assertNonce(registration.nonce);
    pruneConsumedNonces();
    if (
      session.nonce ||
      pendingByNonce.has(registration.nonce) ||
      consumedNonces.has(registration.nonce)
    ) throw new BrokerProtocolError("nonce_replayed");
    if (consumedNonces.size >= MAX_TRACKED_NONCES) throw new BrokerProtocolError("broker_capacity");
    session.nonce = registration.nonce;
    pendingByNonce.set(registration.nonce, session);
    consumedNonces.set(registration.nonce, Date.now() + nonceRetentionMs);
    session.registrationTimer = setTimeout(() => {
      if (pendingByNonce.get(registration.nonce) === session) pendingByNonce.delete(registration.nonce);
      session.nonce = null;
      session.registrationTimer = null;
      diagnose("registration_timeout", "claim_timeout");
    }, registrationTimeoutMs);
    session.registrationTimer.unref?.();
    diagnose("nonce_registered");
    return { registered: true, expiresInMs: registrationTimeoutMs };
  }

  async function claim(nonce, routeContext) {
    assertNonce(nonce);
    const route = normalizeRoute(routeContext);
    const session = pendingByNonce.get(nonce);
    if (!session || session.closed || !session.authenticated) {
      throw new BrokerProtocolError(consumedNonces.has(nonce) ? "nonce_replayed" : "nonce_unknown");
    }
    // Synchronous consume-before-yield gives exactly one concurrent claimant.
    if (!pendingByNonce.delete(nonce)) throw new BrokerProtocolError("nonce_replayed");
    session.nonce = null;
    clearTimer(session.registrationTimer);
    session.registrationTimer = null;
    const claimToken = randomBytes(32).toString("hex");
    const routeHash = hashRoute(routeHmacKey, route);
    const claimRecord = { claimToken, routeHash, webContentsId: route.webContentsId, session };
    claims.set(claimToken, claimRecord);
    try {
      const initial = await session.peer.request("claimed", { claimToken, routeHash }, requestTimeoutMs);
      diagnose("nonce_claimed");
      return Object.freeze({ status: "claimed", claimToken, routeHash, initial });
    } catch (error) {
      claims.delete(claimToken);
      diagnose("claim_rejected", errorCode(error));
      throw error;
    }
  }

  async function request(claimToken, routeContext, method, payload = {}, timeoutMs) {
    const claimRecord = requireClaim(claimToken, routeContext);
    // Constructing a protocol request performs method/payload bounds validation
    // before anything crosses the process boundary.
    requestFrame("validation", method, payload);
    try {
      return await claimRecord.session.peer.request(method, payload, boundedTimeout(timeoutMs, requestTimeoutMs));
    } catch (error) {
      diagnose("claim_request_failed", errorCode(error));
      throw error;
    }
  }

  function deliver(claimToken, routeContext, channel, ...args) {
    const claimRecord = requireClaim(claimToken, routeContext);
    if (typeof channel !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(channel)) {
      throw new BrokerProtocolError("channel_invalid");
    }
    requestFrame("validation", "deliver", { args });
    const delivered = sendToRenderer(claimRecord.webContentsId, channel, ...args) === true;
    if (!delivered) {
      claims.delete(claimToken);
      diagnose("renderer_delivery_failed", "renderer_unavailable");
    } else {
      diagnose("renderer_delivered");
    }
    return delivered;
  }

  /**
   * The standalone MCP remains the only server owner.  This registration only
   * records a live renderer that can receive an optional enhancement request.
   * Ambiguity is intentionally a generic-form fallback, never a best guess.
   */
  function registerEnhancementRenderer(webContentsId) {
    assertRendererId(webContentsId);
    enhancementRenderers.add(webContentsId);
    return Object.freeze({ registered: true });
  }

  function unregisterEnhancementRenderer(webContentsId) {
    assertRendererId(webContentsId);
    enhancementRenderers.delete(webContentsId);
    for (const [sessionId, session] of enhancementSessions) {
      if (session.webContentsId === webContentsId) abandonEnhancementSession(sessionId, "renderer_unavailable");
    }
    return true;
  }

  function claimEnhancement(value) {
    const claim = exactEnhancementClaim(value);
    if (!started || stopping || enhancementSessions.size >= MAX_ENHANCEMENT_SESSIONS) {
      throw new BrokerProtocolError("enhancement_unavailable");
    }
    const rendererIds = [...enhancementRenderers];
    if (rendererIds.length !== 1) throw new BrokerProtocolError("renderer_unavailable");
    const sessionId = randomUUID();
    const session = {
      id: sessionId,
      claimId: claim.id,
      routeFingerprint: claim.route_fingerprint,
      inputFingerprint: claim.input_fingerprint,
      webContentsId: rendererIds[0],
      state: "claimed",
      timer: null,
      pending: null,
    };
    session.timer = setTimeout(() => abandonEnhancementSession(sessionId, "claim_timeout"), enhancementClaimTtlMs);
    session.timer.unref?.();
    enhancementSessions.set(sessionId, session);
    diagnose("enhancement_claimed");
    return Object.freeze({
      version: ENHANCEMENT_PROTOCOL_VERSION,
      type: "claimed",
      route_fingerprint: claim.route_fingerprint,
      input_fingerprint: claim.input_fingerprint,
      session_id: sessionId,
    });
  }

  function deliverEnhancement(value, socket) {
    const delivery = exactEnhancementDelivery(value);
    const session = enhancementSessions.get(delivery.session_id);
    if (!session || session.state !== "claimed") throw new BrokerProtocolError("session_inactive");
    if (
      !secureEqualString(session.routeFingerprint, delivery.route_fingerprint)
      || !secureEqualString(session.inputFingerprint, delivery.input_fingerprint)
    ) {
      abandonEnhancementSession(session.id, "fingerprint_mismatch");
      throw new BrokerProtocolError("fingerprint_mismatch");
    }
    if (!enhancementRenderers.has(session.webContentsId)) {
      abandonEnhancementSession(session.id, "renderer_unavailable");
      throw new BrokerProtocolError("renderer_unavailable");
    }
    clearTimer(session.timer);
    session.timer = null;
    session.state = "delivering";
    return new Promise((resolve, reject) => {
      session.pending = { resolve, reject, socket };
      const delivered = sendToRenderer(session.webContentsId, "enhancement.deliver", Object.freeze({
        version: ENHANCEMENT_PROTOCOL_VERSION,
        type: "deliver",
        id: delivery.id,
        session_id: session.id,
        route_fingerprint: session.routeFingerprint,
        input_fingerprint: session.inputFingerprint,
        elicitation: delivery.elicitation,
      })) === true;
      if (!delivered) {
        abandonEnhancementSession(session.id, "renderer_unavailable");
        return;
      }
      diagnose("enhancement_deliver_requested");
    });
  }

  function acknowledgeEnhancement(webContentsId, value) {
    assertRendererId(webContentsId);
    const acknowledgement = exactEnhancementAcknowledgement(value);
    const session = requireEnhancementSession(acknowledgement, webContentsId, "delivering");
    session.state = "delivered";
    diagnose("enhancement_renderer_delivered");
    return Object.freeze({ acknowledged: true });
  }

  function respondEnhancement(webContentsId, value) {
    assertRendererId(webContentsId);
    const response = exactEnhancementResponse(value);
    const session = requireEnhancementSession(response, webContentsId, "delivered");
    const pending = session.pending;
    if (!pending) throw new BrokerProtocolError("session_inactive");
    session.pending = null;
    enhancementSessions.delete(session.id);
    clearTimer(session.timer);
    pending.resolve(Object.freeze({
      version: ENHANCEMENT_PROTOCOL_VERSION,
      type: "delivered",
      session_id: session.id,
      route_fingerprint: session.routeFingerprint,
      input_fingerprint: session.inputFingerprint,
      response: response.response,
    }));
    diagnose("enhancement_response_delivered");
    return Object.freeze({ delivered: true });
  }

  function requireEnhancementSession(value, webContentsId, stateName) {
    const session = enhancementSessions.get(value.session_id);
    if (!session || session.state !== stateName || session.webContentsId !== webContentsId) {
      throw new BrokerProtocolError("session_inactive");
    }
    if (
      !secureEqualString(session.routeFingerprint, value.route_fingerprint)
      || !secureEqualString(session.inputFingerprint, value.input_fingerprint)
    ) {
      abandonEnhancementSession(session.id, "fingerprint_mismatch");
      throw new BrokerProtocolError("fingerprint_mismatch");
    }
    return session;
  }

  function abandonEnhancementDelivery(sessionId, socket) {
    const session = enhancementSessions.get(sessionId);
    if (!session || session.pending?.socket !== socket) return;
    abandonEnhancementSession(sessionId, "client_disconnected");
  }

  function abandonEnhancementSession(sessionId, code) {
    const session = enhancementSessions.get(sessionId);
    if (!session) return;
    enhancementSessions.delete(sessionId);
    clearTimer(session.timer);
    session.timer = null;
    const pending = session.pending;
    session.pending = null;
    if (pending) pending.reject(new BrokerProtocolError(code));
    diagnose("enhancement_session_released", code);
  }

  function observeRoute(claimToken, routeContext) {
    try {
      requireClaim(claimToken, routeContext);
      return true;
    } catch (error) {
      if (error instanceof BrokerProtocolError) return false;
      throw error;
    }
  }

  function release(claimToken, routeContext) {
    requireClaim(claimToken, routeContext);
    const released = claims.delete(claimToken);
    if (released) diagnose("claim_released");
    return released;
  }

  function requireClaim(claimToken, routeContext) {
    if (typeof claimToken !== "string" || !/^[a-f0-9]{64}$/.test(claimToken)) {
      throw new BrokerProtocolError("claim_invalid");
    }
    const claimRecord = claims.get(claimToken);
    if (!claimRecord || claimRecord.session.closed) throw new BrokerProtocolError("claim_inactive");
    const route = normalizeRoute(routeContext);
    if (route.webContentsId !== claimRecord.webContentsId) {
      diagnose("renderer_mismatch", "renderer_mismatch");
      throw new BrokerProtocolError("renderer_mismatch");
    }
    if (!secureEqualString(hashRoute(routeHmacKey, route), claimRecord.routeHash)) {
      claims.delete(claimToken);
      diagnose("route_invalidated", "route_invalidated");
      throw new BrokerProtocolError("route_invalidated");
    }
    return claimRecord;
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    for (const session of [...sessions]) session.peer.close();
    pendingByNonce.clear();
    claims.clear();
    consumedNonces.clear();
    enhancementRenderers.clear();
    for (const sessionId of [...enhancementSessions.keys()]) {
      abandonEnhancementSession(sessionId, "broker_stopped");
    }
    const activeServer = server;
    server = null;
    if (activeServer) await closeServer(activeServer);
    const activeEnhancementServer = enhancementServer;
    enhancementServer = null;
    if (activeEnhancementServer) await closeServer(activeEnhancementServer);
    removeOwnedMetadata(metadataPath, socketPath, secret);
    rmSync(socketPath, { force: true });
    removeOwnedEnhancementSocket();
    routeHmacKey?.fill(0);
    routeHmacKey = null;
    started = false;
    diagnose("broker_stopped");
  }

  function removeOwnedEnhancementSocket() {
    if (!enhancementSocketPath || !ownedEnhancementSocket) return;
    try {
      const observed = socketIdentity(enhancementSocketPath);
      if (observed && observed.dev === ownedEnhancementSocket.dev && observed.ino === ownedEnhancementSocket.ino) {
        rmSync(enhancementSocketPath, { force: true });
      }
    } catch {}
    ownedEnhancementSocket = null;
  }

  function cleanupSession(session) {
    if (session.closed) return;
    session.closed = true;
    clearTimer(session.authTimer);
    clearTimer(session.registrationTimer);
    if (session.nonce && pendingByNonce.get(session.nonce) === session) pendingByNonce.delete(session.nonce);
    for (const [claimToken, claimRecord] of claims) {
      if (claimRecord.session === session) claims.delete(claimToken);
    }
    sessions.delete(session);
    diagnose("session_closed");
  }

  function pruneConsumedNonces() {
    const now = Date.now();
    for (const [nonce, expiresAt] of consumedNonces) {
      if (expiresAt <= now) consumedNonces.delete(nonce);
    }
  }

  function endpoint() {
    return Object.freeze({ metadataPath, socketPath, enhancementSocketPath, version: BROKER_PROTOCOL_VERSION });
  }

  function diagnose(event, code) {
    if (typeof options.onDiagnostic !== "function") return;
    try { options.onDiagnostic(redactedDiagnostic(event, code)); } catch {}
  }

  return Object.freeze({
    start,
    stop,
    claim,
    request,
    deliver,
    observeRoute,
    release,
    registerEnhancementRenderer,
    unregisterEnhancementRenderer,
    acknowledgeEnhancement,
    respondEnhancement,
    endpoint,
    snapshot: () => Object.freeze({
      started,
      sessions: sessions.size,
      pendingRegistrations: pendingByNonce.size,
      activeClaims: claims.size,
      consumedNonces: consumedNonces.size,
      enhancementRenderers: enhancementRenderers.size,
      enhancementSessions: enhancementSessions.size,
      contentRedacted: true,
    }),
  });
}

function normalizeRoute(value) {
  const route = exactPayload(value, ["webContentsId", "hostId", "conversationId"]);
  if (!Number.isSafeInteger(route.webContentsId) || route.webContentsId <= 0) {
    throw new BrokerProtocolError("renderer_invalid");
  }
  return {
    webContentsId: route.webContentsId,
    hostId: normalizeRoutePart(route.hostId),
    conversationId: normalizeRoutePart(route.conversationId),
  };
}

function normalizeRoutePart(value) {
  if (typeof value !== "string") throw new BrokerProtocolError("route_invalid");
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > ROUTE_PART_MAX_LENGTH) throw new BrokerProtocolError("route_invalid");
  return normalized;
}

function hashRoute(key, route) {
  if (!Buffer.isBuffer(key) || key.byteLength !== ROUTE_HMAC_KEY_BYTES) {
    throw new BrokerProtocolError("data_dir_invalid");
  }
  return createHmac("sha256", key)
    .update(JSON.stringify([route.webContentsId, route.hostId, route.conversationId]))
    .digest("hex");
}

function exactPayload(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerProtocolError("payload_invalid");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new BrokerProtocolError("payload_invalid");
  }
  return value;
}

function preparePrivateDataDirectory(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dataDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BrokerProtocolError("data_dir_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new BrokerProtocolError("data_dir_owner_invalid");
  }
  if ((stat.mode & 0o777) !== 0o700) chmodSync(dataDir, 0o700);
}

function loadOrCreateRouteHmacKey(dataDir) {
  const keyPath = path.join(dataDir, ROUTE_HMAC_KEY_FILE);
  try {
    return readRouteHmacKey(keyPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw fixedRouteKeyError(error);
  }

  const tempPath = `${keyPath}.${randomBytes(8).toString("hex")}.tmp`;
  const encodedKey = randomBytes(ROUTE_HMAC_KEY_BYTES).toString("hex");
  let descriptor;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, encodedKey, "ascii");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(tempPath, keyPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    rmSync(tempPath, { force: true });
    fsyncDirectory(dataDir);
    return readRouteHmacKey(keyPath);
  } catch (error) {
    throw fixedRouteKeyError(error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(tempPath, { force: true });
  }
}

function readRouteHmacKey(keyPath) {
  let pathStat;
  try {
    pathStat = lstatSync(keyPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw fixedRouteKeyError(error);
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new BrokerProtocolError("data_dir_invalid");
  }
  assertPrivateRouteKeyStat(pathStat);

  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new BrokerProtocolError("data_dir_invalid");
  }
  let descriptor;
  try {
    descriptor = openSync(keyPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptorStat = fstatSync(descriptor);
    if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
      throw new BrokerProtocolError("data_dir_invalid");
    }
    assertPrivateRouteKeyStat(descriptorStat);
    if (descriptorStat.size !== ROUTE_HMAC_KEY_HEX_LENGTH) {
      throw new BrokerProtocolError("data_dir_invalid");
    }
    const encodedKey = readFileSync(descriptor);
    if (
      encodedKey.byteLength !== ROUTE_HMAC_KEY_HEX_LENGTH
      || !/^[a-f0-9]{64}$/.test(encodedKey.toString("ascii"))
    ) throw new BrokerProtocolError("data_dir_invalid");
    return Buffer.from(encodedKey.toString("ascii"), "hex");
  } catch (error) {
    throw fixedRouteKeyError(error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertPrivateRouteKeyStat(stat) {
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new BrokerProtocolError("data_dir_invalid");
  }
  if (
    typeof process.getuid !== "function"
    || !Number.isSafeInteger(stat.uid)
    || stat.uid !== process.getuid()
  ) throw new BrokerProtocolError("data_dir_owner_invalid");
}

function fsyncDirectory(dataDir) {
  let descriptor;
  try {
    descriptor = openSync(dataDir, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fixedRouteKeyError(error) {
  if (error instanceof BrokerProtocolError) return error;
  return new BrokerProtocolError("data_dir_invalid");
}

function writeMetadata(metadataPath, metadata) {
  const tempPath = `${metadataPath}.${randomBytes(8).toString("hex")}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
  let descriptor;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, metadataPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(tempPath, { force: true });
  }
}

function removeOwnedMetadata(metadataPath, socketPath, secret) {
  if (!existsSync(metadataPath)) return;
  try {
    const observed = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (observed?.socketPath === socketPath && secureEqualString(observed?.secret, secret)) {
      rmSync(metadataPath, { force: true });
    }
  } catch {}
}

function selectSocketPath(dataDir, requestedPath) {
  if (requestedPath !== undefined) {
    const explicit = requireAbsolutePath(requestedPath, "socket_path_invalid");
    if (Buffer.byteLength(explicit) > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw new BrokerProtocolError("socket_path_oversize");
    }
    return explicit;
  }
  const suffix = randomBytes(8).toString("hex");
  const local = path.join(dataDir, `.uq-${suffix}.sock`);
  if (Buffer.byteLength(local) <= MAX_UNIX_SOCKET_PATH_BYTES) return local;
  const digest = createHash("sha256").update(`${dataDir}\0${suffix}`).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), `tweakers-uq-${digest}.sock`);
}

/**
 * The standalone User Questions plugin discovers this optional endpoint through
 * USER_QUESTIONS_ENHANCEMENT_SOCKET. It is deliberately supplied by the
 * embedding environment: Tweakers never writes MCP configuration or launches
 * the service that owns the generic form.
 */
function resolveEnhancementSocketPath(requestedPath) {
  if (requestedPath === undefined || requestedPath === null || requestedPath === "") return null;
  const explicit = requireAbsolutePath(requestedPath, "socket_path_invalid");
  if (Buffer.byteLength(explicit) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new BrokerProtocolError("socket_path_oversize");
  }
  return explicit;
}

/** Frozen v1 response shape for a separately validated enhancement claim. */
function createEnhancementClaimResponse(value) {
  const claim = exactEnhancementClaim(value);
  return Object.freeze({
    version: ENHANCEMENT_PROTOCOL_VERSION,
    type: "claimed",
    route_fingerprint: claim.route_fingerprint,
    input_fingerprint: claim.input_fingerprint,
    session_id: randomUUID(),
  });
}

function exactEnhancementClaim(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerProtocolError("payload_invalid");
  }
  const keys = Object.keys(value).sort();
  const expected = ["id", "input_fingerprint", "route_fingerprint", "type", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new BrokerProtocolError("payload_invalid");
  }
  if (value.version !== ENHANCEMENT_PROTOCOL_VERSION || value.type !== "claim") {
    throw new BrokerProtocolError("version_unsupported");
  }
  if (typeof value.id !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(value.id)) {
    throw new BrokerProtocolError("id_invalid");
  }
  if (
    typeof value.route_fingerprint !== "string"
    || typeof value.input_fingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(value.route_fingerprint)
    || !/^[a-f0-9]{64}$/.test(value.input_fingerprint)
  ) throw new BrokerProtocolError("payload_invalid");
  return value;
}

function exactEnhancementDelivery(value) {
  const delivery = exactEnhancementEnvelope(value, [
    "elicitation",
    "id",
    "input_fingerprint",
    "route_fingerprint",
    "session_id",
    "type",
    "version",
  ], "deliver");
  if (!validRequestId(delivery.id) || !validSessionId(delivery.session_id) || !isRecord(delivery.elicitation)) {
    throw new BrokerProtocolError("payload_invalid");
  }
  return delivery;
}

function exactEnhancementAcknowledgement(value) {
  const acknowledgement = exactEnhancementEnvelope(value, [
    "input_fingerprint",
    "route_fingerprint",
    "session_id",
    "type",
    "version",
  ], "acknowledged");
  if (!validSessionId(acknowledgement.session_id)) throw new BrokerProtocolError("payload_invalid");
  return acknowledgement;
}

function exactEnhancementResponse(value) {
  const response = exactEnhancementEnvelope(value, [
    "input_fingerprint",
    "response",
    "route_fingerprint",
    "session_id",
    "type",
    "version",
  ], "response");
  if (!validSessionId(response.session_id) || !isGenericFormResponse(response.response)) {
    throw new BrokerProtocolError("payload_invalid");
  }
  return response;
}

function exactEnhancementEnvelope(value, expected, type) {
  if (!isRecord(value)) throw new BrokerProtocolError("payload_invalid");
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new BrokerProtocolError("payload_invalid");
  }
  if (value.version !== ENHANCEMENT_PROTOCOL_VERSION || value.type !== type) {
    throw new BrokerProtocolError("version_unsupported");
  }
  if (!validFingerprint(value.route_fingerprint) || !validFingerprint(value.input_fingerprint)) {
    throw new BrokerProtocolError("payload_invalid");
  }
  return value;
}

function isGenericFormResponse(value) {
  if (!isRecord(value) || !["accept", "cancel", "decline"].includes(value.action)) return false;
  const keys = Object.keys(value).sort();
  if (value.action === "accept") {
    return keys.length === 2 && keys[0] === "action" && keys[1] === "content" && isRecord(value.content);
  }
  return keys.length === 1 && keys[0] === "action";
}

function validRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(value);
}

function validSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validFingerprint(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRendererId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new BrokerProtocolError("renderer_invalid");
}

function assertEnhancementSocketAvailable(socketPath) {
  try {
    lstatSync(socketPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new BrokerProtocolError("socket_path_invalid");
  }
  throw new BrokerProtocolError("enhancement_socket_occupied");
}

function socketIdentity(socketPath) {
  const stat = lstatSync(socketPath);
  if (!stat.isSocket()) throw new BrokerProtocolError("socket_path_invalid");
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function requireAbsolutePath(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new BrokerProtocolError(code);
  }
  return path.normalize(value);
}

function requireTweakId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new BrokerProtocolError("tweak_id_invalid");
  }
  return value;
}

function boundedTimeout(value, fallback, maximum = 60_000) {
  return Number.isSafeInteger(value) && value >= 50 && value <= maximum ? value : fallback;
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}

function errorCode(error) {
  return error instanceof BrokerProtocolError ? error.code : "request_failed";
}

module.exports = {
  ENHANCEMENT_PROTOCOL_VERSION,
  ENHANCEMENT_SOCKET_ENV,
  ROUTE_HMAC_KEY_FILE,
  createEnhancementClaimResponse,
  createMainBroker,
  hashRoute,
};

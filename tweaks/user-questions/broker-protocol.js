"use strict";

const { randomUUID, timingSafeEqual } = require("node:crypto");
const { lstatSync, readFileSync } = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const BROKER_PROTOCOL_VERSION = 1;
const BROKER_MAX_FRAME_BYTES = 131_072;
const BROKER_MAX_JSON_DEPTH = 16;
const BROKER_MAX_JSON_NODES = 4_096;
const BROKER_DEFAULT_TIMEOUT_MS = 5_000;
const BROKER_METADATA_FILE = "user-questions-broker.v1.json";
const CARRIER_NONCE_PREFIX = "__tweakers_carrier_nonce_";
const REQUIRED_BROKER_PERMISSIONS = Object.freeze(["ipc", "network"]);
const ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const METHOD_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const NONCE_PATTERN = /^[A-Za-z0-9._~-]{8,128}$/;
const PUBLIC_ERROR_CODES = new Set([
  "auth_failed", "auth_replayed", "auth_required", "auth_timeout", "broker_capacity",
  "broker_stopping", "channel_invalid", "claim_inactive", "claim_invalid", "claim_timeout",
  "connect_failed", "connect_timeout", "data_dir_invalid", "data_dir_owner_invalid",
  "error_invalid", "frame_empty", "frame_invalid_json", "frame_invalid_kind",
  "frame_invalid_shape", "frame_oversize", "frame_truncated", "id_invalid",
  "metadata_invalid", "metadata_oversize", "metadata_owner_invalid", "metadata_path_invalid",
  "metadata_permissions_invalid", "method_invalid", "method_unsupported",
  "missing_ipc_network_permission", "missing_ipc_permission", "missing_network_permission",
  "nonce_invalid", "nonce_replayed", "nonce_unknown", "payload_invalid", "payload_too_complex",
  "payload_too_deep", "protocol_failed", "renderer_delivery_missing", "renderer_invalid",
  "renderer_mismatch", "renderer_unavailable", "request_failed", "request_timeout",
  "route_invalid", "route_invalidated", "socket_closed", "socket_error", "socket_path_invalid",
  "socket_path_oversize", "tweak_id_invalid", "version_unsupported",
]);
const DIAGNOSTIC_EVENTS = new Set([
  "authenticated", "authentication_rejected", "authentication_timeout", "broker_started",
  "broker_stopped", "claim_rejected", "claim_released", "claim_request_failed",
  "connection_rejected", "diagnostic", "nonce_claimed", "nonce_registered",
  "protocol_rejected", "registration_timeout", "renderer_delivered", "renderer_delivery_failed",
  "renderer_mismatch", "route_invalidated", "session_closed",
]);

class BrokerProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = "BrokerProtocolError";
    this.code = code;
  }
}

function assertBrokerPermissions(permissions) {
  const declared = new Set(Array.isArray(permissions) ? permissions : []);
  const missing = REQUIRED_BROKER_PERMISSIONS.filter((permission) => !declared.has(permission));
  if (missing.length) throw new BrokerProtocolError(`missing_${missing.join("_")}_permission`);
}

function requestFrame(id, method, payload = {}) {
  return validateFrame({
    version: BROKER_PROTOCOL_VERSION,
    kind: "request",
    id,
    method,
    payload,
  });
}

function successFrame(id, result = {}) {
  return validateFrame({
    version: BROKER_PROTOCOL_VERSION,
    kind: "response",
    id,
    ok: true,
    result,
  });
}

function errorFrame(id, code) {
  return validateFrame({
    version: BROKER_PROTOCOL_VERSION,
    kind: "response",
    id,
    ok: false,
    error: { code: safePublicErrorCode(code) },
  });
}

function encodeFrame(frame) {
  const normalized = validateFrame(frame);
  const encoded = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
  if (encoded.byteLength - 1 > BROKER_MAX_FRAME_BYTES) {
    throw new BrokerProtocolError("frame_oversize");
  }
  return encoded;
}

function decodeFrame(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  const payload = buffer.at(-1) === 0x0a ? buffer.subarray(0, -1) : buffer;
  if (payload.byteLength === 0) throw new BrokerProtocolError("frame_empty");
  if (payload.byteLength > BROKER_MAX_FRAME_BYTES) throw new BrokerProtocolError("frame_oversize");
  let parsed;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new BrokerProtocolError("frame_invalid_json");
  }
  return validateFrame(parsed);
}

function validateFrame(value) {
  const frame = plainRecord(value, "frame_invalid_shape");
  if (frame.version !== BROKER_PROTOCOL_VERSION) throw new BrokerProtocolError("version_unsupported");
  if (!ID_PATTERN.test(frame.id || "")) throw new BrokerProtocolError("id_invalid");
  if (frame.kind === "request") {
    exactKeys(frame, ["version", "kind", "id", "method", "payload"]);
    if (!METHOD_PATTERN.test(frame.method || "")) throw new BrokerProtocolError("method_invalid");
    validateJsonValue(frame.payload);
    return frame;
  }
  if (frame.kind === "response") {
    if (frame.ok === true) {
      exactKeys(frame, ["version", "kind", "id", "ok", "result"]);
      validateJsonValue(frame.result);
      return frame;
    }
    if (frame.ok === false) {
      exactKeys(frame, ["version", "kind", "id", "ok", "error"]);
      const error = plainRecord(frame.error, "error_invalid");
      exactKeys(error, ["code"]);
      if (!PUBLIC_ERROR_CODES.has(error.code)) throw new BrokerProtocolError("error_invalid");
      return frame;
    }
  }
  throw new BrokerProtocolError("frame_invalid_kind");
}

function createFrameDecoder({ onFrame, onError }) {
  if (typeof onFrame !== "function" || typeof onError !== "function") {
    throw new TypeError("frame decoder requires onFrame and onError callbacks");
  }
  let buffered = Buffer.alloc(0);
  let failed = false;
  return Object.freeze({
    push(chunk) {
      if (failed) return;
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      try {
        for (;;) {
          const newline = buffered.indexOf(0x0a);
          if (newline === -1) break;
          if (newline > BROKER_MAX_FRAME_BYTES) throw new BrokerProtocolError("frame_oversize");
          const frame = buffered.subarray(0, newline);
          buffered = buffered.subarray(newline + 1);
          if (frame.byteLength) onFrame(decodeFrame(frame));
        }
        if (buffered.byteLength > BROKER_MAX_FRAME_BYTES) throw new BrokerProtocolError("frame_oversize");
      } catch (error) {
        failed = true;
        buffered = Buffer.alloc(0);
        onError(asProtocolError(error));
      }
    },
    end() {
      if (!failed && buffered.byteLength !== 0) {
        failed = true;
        buffered = Buffer.alloc(0);
        onError(new BrokerProtocolError("frame_truncated"));
      }
    },
  });
}

function createProtocolPeer(socket, options = {}) {
  if (!socket || typeof socket.write !== "function" || typeof socket.on !== "function") {
    throw new TypeError("protocol peer requires a duplex socket");
  }
  const pending = new Map();
  const timeoutMs = boundedTimeout(options.requestTimeoutMs, BROKER_DEFAULT_TIMEOUT_MS);
  let requestHandler = typeof options.onRequest === "function" ? options.onRequest : null;
  let closed = false;

  const decoder = createFrameDecoder({
    onFrame(frame) {
      if (frame.kind === "response") {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.ok) entry.resolve(frame.result);
        else entry.reject(new BrokerProtocolError(frame.error.code));
        return;
      }
      void handleInboundRequest(frame);
    },
    onError(error) {
      emitDiagnostic(options.onDiagnostic, "protocol_rejected", error.code);
      destroy(error);
    },
  });

  socket.on("data", (chunk) => decoder.push(chunk));
  socket.on("end", () => decoder.end());
  socket.on("error", () => destroy(new BrokerProtocolError("socket_error")));
  socket.on("close", () => destroy(new BrokerProtocolError("socket_closed"), false));

  async function handleInboundRequest(frame) {
    if (!requestHandler) {
      safeWrite(errorFrame(frame.id, "method_unsupported"));
      return;
    }
    try {
      const result = await requestHandler(frame.method, frame.payload);
      safeWrite(successFrame(frame.id, result === undefined ? {} : result));
    } catch (error) {
      safeWrite(errorFrame(frame.id, publicErrorCode(error)));
    }
  }

  function safeWrite(frame) {
    if (closed || socket.destroyed) throw new BrokerProtocolError("socket_closed");
    socket.write(encodeFrame(frame));
  }

  function destroy(error = new BrokerProtocolError("socket_closed"), destroySocket = true) {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    if (destroySocket && !socket.destroyed) socket.destroy();
    options.onClose?.();
  }

  return Object.freeze({
    request(method, payload = {}, requestedTimeoutMs) {
      if (closed || socket.destroyed) return Promise.reject(new BrokerProtocolError("socket_closed"));
      const id = randomUUID();
      const frame = requestFrame(id, method, payload);
      const requestTimeoutMs = boundedTimeout(requestedTimeoutMs, timeoutMs);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(new BrokerProtocolError("request_timeout"));
        }, requestTimeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          safeWrite(frame);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(asProtocolError(error));
        }
      });
    },
    setRequestHandler(handler) {
      if (handler !== null && typeof handler !== "function") throw new TypeError("request handler must be a function");
      requestHandler = handler;
    },
    close() {
      destroy(new BrokerProtocolError("socket_closed"));
    },
    get closed() {
      return closed;
    },
  });
}

async function connectBroker(options = {}) {
  const dataDir = options.dataDir;
  const tweakId = options.tweakId;
  const metadata = readBrokerMetadata(dataDir, tweakId);
  const timeoutMs = boundedTimeout(options.timeoutMs, BROKER_DEFAULT_TIMEOUT_MS);
  const socket = await connectSocket(metadata.socketPath, timeoutMs);
  const peer = createProtocolPeer(socket, options);
  try {
    await peer.request("authenticate", { secret: metadata.secret }, timeoutMs);
  } catch (error) {
    peer.close();
    throw error;
  }
  return Object.freeze({
    register: (nonce, requestedTimeoutMs) => {
      assertNonce(nonce);
      return peer.request("register", { nonce }, requestedTimeoutMs);
    },
    request: peer.request,
    setRequestHandler: peer.setRequestHandler,
    close: peer.close,
  });
}

function readBrokerMetadata(dataDir, expectedTweakId) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new BrokerProtocolError("metadata_path_invalid");
  }
  const metadataPath = path.join(dataDir, BROKER_METADATA_FILE);
  const stat = lstatSync(metadataPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new BrokerProtocolError("metadata_invalid");
  if ((stat.mode & 0o777) !== 0o600) throw new BrokerProtocolError("metadata_permissions_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new BrokerProtocolError("metadata_owner_invalid");
  }
  const bytes = readFileSync(metadataPath);
  if (bytes.byteLength > 4_096) throw new BrokerProtocolError("metadata_oversize");
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new BrokerProtocolError("metadata_invalid"); }
  const metadata = plainRecord(parsed, "metadata_invalid");
  exactKeys(metadata, ["version", "tweakId", "socketPath", "secret"]);
  if (
    metadata.version !== BROKER_PROTOCOL_VERSION ||
    metadata.tweakId !== expectedTweakId ||
    typeof metadata.socketPath !== "string" ||
    !path.isAbsolute(metadata.socketPath) ||
    typeof metadata.secret !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.secret)
  ) throw new BrokerProtocolError("metadata_invalid");
  return Object.freeze(metadata);
}

function connectSocket(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new BrokerProtocolError("connect_timeout"));
    }, timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new BrokerProtocolError("connect_failed"));
    });
  });
}

function validateJsonValue(root) {
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();
  let visited = 0;
  while (queue.length) {
    const { value, depth } = queue.shift();
    visited += 1;
    if (visited > BROKER_MAX_JSON_NODES) throw new BrokerProtocolError("payload_too_complex");
    if (depth > BROKER_MAX_JSON_DEPTH) throw new BrokerProtocolError("payload_too_deep");
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value !== "object" || seen.has(value)) throw new BrokerProtocolError("payload_invalid");
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) queue.push({ value: item, depth: depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new BrokerProtocolError("payload_invalid");
    for (const [key, item] of Object.entries(value)) {
      if (!key || key.length > 512) throw new BrokerProtocolError("payload_invalid");
      queue.push({ value: item, depth: depth + 1 });
    }
  }
}

function exactKeys(record, expected) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new BrokerProtocolError("frame_invalid_shape");
  }
}

function plainRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrokerProtocolError(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new BrokerProtocolError(code);
  return value;
}

function assertNonce(value) {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) throw new BrokerProtocolError("nonce_invalid");
}

function boundedTimeout(value, fallback) {
  return Number.isSafeInteger(value) && value >= 50 && value <= 60_000 ? value : fallback;
}

function secureEqualString(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function publicErrorCode(error) {
  return error instanceof BrokerProtocolError && PUBLIC_ERROR_CODES.has(error.code)
    ? error.code
    : "request_failed";
}

function asProtocolError(error) {
  return error instanceof BrokerProtocolError ? error : new BrokerProtocolError("protocol_failed");
}

function redactedDiagnostic(event, code) {
  const record = {
    event: DIAGNOSTIC_EVENTS.has(event) ? event : "diagnostic",
    contentRedacted: true,
  };
  if (PUBLIC_ERROR_CODES.has(code)) record.code = code;
  return Object.freeze(record);
}

function safePublicErrorCode(code) {
  return PUBLIC_ERROR_CODES.has(code) ? code : "request_failed";
}

function emitDiagnostic(listener, event, code) {
  if (typeof listener !== "function") return;
  try { listener(redactedDiagnostic(event, code)); } catch {}
}

module.exports = {
  BROKER_DEFAULT_TIMEOUT_MS,
  BROKER_MAX_FRAME_BYTES,
  BROKER_METADATA_FILE,
  BROKER_PROTOCOL_VERSION,
  CARRIER_NONCE_PREFIX,
  REQUIRED_BROKER_PERMISSIONS,
  BrokerProtocolError,
  assertBrokerPermissions,
  assertNonce,
  connectBroker,
  createFrameDecoder,
  createProtocolPeer,
  decodeFrame,
  encodeFrame,
  errorFrame,
  readBrokerMetadata,
  redactedDiagnostic,
  requestFrame,
  secureEqualString,
  successFrame,
  validateFrame,
};

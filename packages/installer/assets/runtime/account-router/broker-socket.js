"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/account-router/broker-socket.ts
var broker_socket_exports = {};
__export(broker_socket_exports, {
  ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS: () => ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS,
  ACCOUNTS_BROKER_CONTROL_SOCKET_FILE: () => ACCOUNTS_BROKER_CONTROL_SOCKET_FILE,
  ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS: () => ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS,
  ACCOUNTS_BROKER_MAX_FRAME_BYTES: () => ACCOUNTS_BROKER_MAX_FRAME_BYTES,
  ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES: () => ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES,
  ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES: () => ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES,
  ACCOUNTS_BROKER_SECRET_FILE: () => ACCOUNTS_BROKER_SECRET_FILE,
  ACCOUNTS_BROKER_SOCKET_FILE: () => ACCOUNTS_BROKER_SOCKET_FILE,
  AccountsBrokerManagerClientV1: () => AccountsBrokerManagerClientV1,
  AccountsBrokerSocketClientV1: () => AccountsBrokerSocketClientV1,
  accountsBrokerConfigPath: () => accountsBrokerConfigPath,
  accountsBrokerRootHash: () => accountsBrokerRootHash,
  accountsBrokerSocketPath: () => accountsBrokerSocketPath,
  probeAccountsBrokerControlStatus: () => probeAccountsBrokerControlStatus,
  readAccountsBrokerSecret: () => readAccountsBrokerSecret,
  reserveAccountsBrokerSocket: () => reserveAccountsBrokerSocket,
  resolveAccountsBrokerRoot: () => resolveAccountsBrokerRoot,
  resolveAccountsBrokerRootResolution: () => resolveAccountsBrokerRootResolution,
  startAccountsBrokerSocket: () => startAccountsBrokerSocket,
  startBrokerControlSocket: () => startBrokerControlSocket
});
module.exports = __toCommonJS(broker_socket_exports);
var import_node_crypto2 = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_node_net = require("node:net");

// ../sdk/dist/process-lock.js
var import_node_crypto = require("node:crypto");
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function readLockOwner(lockFile) {
  try {
    const pid = Number.parseInt((0, import_node_fs.readFileSync)(lockFile, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function processStartedAt(pid) {
  const result = (0, import_node_child_process.spawnSync)("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2e3 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
function processIdentityAlive(pid, startedAt) {
  if (!processAlive(pid))
    return false;
  if (!startedAt)
    return true;
  const observed = processStartedAt(pid);
  return observed === null || observed === startedAt;
}
function fileOwnerAlive(file, pid) {
  try {
    const metadata = (0, import_node_fs.readFileSync)(file, "utf8").split("\n")[1];
    const startedAt = metadata ? JSON.parse(metadata).startedAt : null;
    return processIdentityAlive(pid, typeof startedAt === "string" ? startedAt : null);
  } catch {
    return processAlive(pid);
  }
}
var CHOOSING_PATTERN = /^choosing-(\d+)-([0-9a-f-]+)$/i;
var TICKET_PATTERN = /^ticket-(\d+)-(\d+)-([0-9a-f-]+)$/i;
function claimDirectory(lockFile) {
  return `${lockFile}.claims`;
}
function removeClaim(file) {
  try {
    (0, import_node_fs.unlinkSync)(file);
  } catch {
  }
}
function createClaim(file, value, close) {
  const fd = (0, import_node_fs.openSync)(file, "wx", 384);
  let failure = null;
  try {
    (0, import_node_fs.writeFileSync)(fd, value);
    (0, import_node_fs.fsyncSync)(fd);
  } catch (error) {
    failure = error;
  }
  try {
    close(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== null) {
    removeClaim(file);
    throw failure;
  }
}
function inspectClaims(lockFile, cleanupDead) {
  const directory = claimDirectory(lockFile);
  if (!(0, import_node_fs.existsSync)(directory))
    return { choosing: [], tickets: [], malformed: false };
  const choosing = [];
  const tickets = [];
  let malformed = false;
  for (const name of (0, import_node_fs.readdirSync)(directory)) {
    if (name.startsWith("."))
      continue;
    const file = (0, import_node_path.join)(directory, name);
    const choosingMatch = CHOOSING_PATTERN.exec(name);
    if (choosingMatch) {
      const pid = Number.parseInt(choosingMatch[1], 10);
      if (!fileOwnerAlive(file, pid)) {
        if (cleanupDead)
          removeClaim(file);
        continue;
      }
      choosing.push({ file, pid, token: choosingMatch[2] });
      continue;
    }
    const ticketMatch = TICKET_PATTERN.exec(name);
    if (ticketMatch) {
      const ticket = Number.parseInt(ticketMatch[1], 10);
      const pid = Number.parseInt(ticketMatch[2], 10);
      if (!Number.isSafeInteger(ticket) || ticket < 1 || !fileOwnerAlive(file, pid)) {
        if (cleanupDead)
          removeClaim(file);
        continue;
      }
      tickets.push({ file, ticket, pid, token: ticketMatch[3] });
      continue;
    }
    malformed = true;
  }
  return { choosing, tickets, malformed };
}
function compareTickets(left, right) {
  if (left.ticket !== right.ticket)
    return left.ticket - right.ticket;
  if (left.pid !== right.pid)
    return left.pid - right.pid;
  return left.token.localeCompare(right.token);
}
function acquireProcessLock(lockFile, opts = {}) {
  (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(lockFile), { recursive: true });
  const claimsDir = claimDirectory(lockFile);
  (0, import_node_fs.mkdirSync)(claimsDir, { recursive: true, mode: 448 });
  const token = (0, import_node_crypto.randomUUID)();
  const claimBody = `${process.pid}
${JSON.stringify({ version: 2, token, startedAt: processStartedAt(process.pid) })}
`;
  const choosingFile = (0, import_node_path.join)(claimsDir, `choosing-${process.pid}-${token}`);
  const contended = (owner) => opts.onContended?.(owner) ?? new Error(owner === null ? "Another process already holds this lock" : `Another process already holds this lock (PID ${owner})`);
  const close = opts.close ?? import_node_fs.closeSync;
  createClaim(choosingFile, claimBody, close);
  let ticketFile = null;
  let ticket = 1;
  try {
    const initial = inspectClaims(lockFile, true);
    if (initial.malformed)
      throw contended(null);
    ticket = initial.tickets.reduce((maximum, claim) => Math.max(maximum, claim.ticket), 0) + 1;
    ticketFile = (0, import_node_path.join)(claimsDir, `ticket-${String(ticket).padStart(16, "0")}-${process.pid}-${token}`);
    createClaim(ticketFile, claimBody, close);
  } finally {
    removeClaim(choosingFile);
  }
  const abandon = (error) => {
    if (ticketFile)
      removeClaim(ticketFile);
    throw error;
  };
  const abandonContended = (owner) => {
    let error;
    try {
      error = contended(owner);
    } catch (callbackError) {
      error = callbackError;
    }
    return abandon(error);
  };
  try {
    opts.beforeSettledInspection?.();
    let settled = inspectClaims(lockFile, true);
    const deadline = Date.now() + 100;
    while (settled.choosing.some((claim) => claim.token !== token && claim.pid !== process.pid) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      settled = inspectClaims(lockFile, true);
    }
    if (settled.malformed)
      return abandonContended(null);
    const otherChooser = settled.choosing.find((claim) => claim.token !== token);
    if (otherChooser)
      return abandonContended(otherChooser.pid);
    const winner = [...settled.tickets].sort(compareTickets)[0];
    if (!winner || winner.token !== token)
      return abandonContended(winner?.pid ?? null);
    opts.afterClaimed?.();
  } catch (error) {
    return abandon(error);
  }
  const createLegacyProjection = () => {
    const fd2 = (0, import_node_fs.openSync)(lockFile, "wx", 384);
    try {
      (0, import_node_fs.writeFileSync)(fd2, claimBody);
      (0, import_node_fs.fsyncSync)(fd2);
      return fd2;
    } catch (error) {
      try {
        close(fd2);
      } catch {
      }
      try {
        (0, import_node_fs.unlinkSync)(lockFile);
      } catch {
      }
      throw error;
    }
  };
  let fd;
  try {
    fd = createLegacyProjection();
  } catch (error) {
    if (error.code !== "EEXIST")
      return abandon(error);
    const owner = readLockOwner(lockFile);
    if (owner !== null && fileOwnerAlive(lockFile, owner))
      return abandonContended(owner);
    try {
      (0, import_node_fs.unlinkSync)(lockFile);
    } catch (unlinkError) {
      if (unlinkError.code !== "ENOENT")
        return abandon(unlinkError);
    }
    try {
      fd = createLegacyProjection();
    } catch {
      return abandonContended(readLockOwner(lockFile));
    }
  }
  let released = false;
  return {
    release: () => {
      if (released)
        return;
      released = true;
      try {
        const descriptor = (0, import_node_fs.fstatSync)(fd);
        const projection = (0, import_node_fs.statSync)(lockFile);
        if (descriptor.dev === projection.dev && descriptor.ino === projection.ino)
          (0, import_node_fs.unlinkSync)(lockFile);
      } catch {
      }
      try {
        close(fd);
      } catch {
      }
      if (ticketFile)
        removeClaim(ticketFile);
    }
  };
}

// src/account-router/broker-socket.ts
var import_node_path2 = require("node:path");
var import_broker = require("./broker");
var import_control_socket = require("./control-socket");
var import_redaction = require("./redaction");
var import_state_store = require("./state-store");
var import_native_request = require("./native-request");
var import_types = require("./types");
var ACCOUNTS_BROKER_SOCKET_FILE = "accounts-broker.v1.sock";
var ACCOUNTS_BROKER_CONTROL_SOCKET_FILE = "broker-control.v1.sock";
var ACCOUNTS_BROKER_SECRET_FILE = "control-secret.v1";
var ACCOUNTS_BROKER_MAX_FRAME_BYTES = 16 * 1024;
var ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES = 1024 * 1024;
var ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES = import_native_request.NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES + 16 * 1024;
var ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS = 5e3;
var ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS = 15e3;
var MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 100;
function resolveAccountsBrokerRootResolution(options) {
  const environment = options.environment ?? process.env;
  const primary = environment.TWEAKERS_ACCOUNTS_BROKER_ROOT;
  const compatibility = environment.TWEAKER_ACCOUNTS_BROKER_ROOT;
  const primaryConfigured = primary !== void 0;
  const compatibilityConfigured = compatibility !== void 0;
  if (!primaryConfigured && !compatibilityConfigured) return { root: null, configured: false };
  if (primaryConfigured && compatibilityConfigured && primary !== compatibility) {
    return { root: null, configured: true };
  }
  const explicit = primaryConfigured ? primary : compatibility;
  if (!isCanonicalAccountsBrokerRoot(explicit)) return { root: null, configured: true };
  return { root: explicit, configured: true };
}
function resolveAccountsBrokerRoot(options) {
  return resolveAccountsBrokerRootResolution(options).root;
}
function isCanonicalAccountsBrokerRoot(value) {
  return typeof value === "string" && value.length > 0 && (0, import_node_path2.isAbsolute)(value) && (0, import_node_path2.resolve)(value) === value;
}
function accountsBrokerConfigPath(root) {
  const resolved = assertBrokerRoot(root);
  return (0, import_node_path2.join)(resolved, "account-router-config.json");
}
function accountsBrokerSocketPath(root, socketFileName = ACCOUNTS_BROKER_SOCKET_FILE) {
  validateSocketFileName(socketFileName);
  const path = (0, import_control_socket.routerControlSocketPath)(assertBrokerRoot(root), socketFileName);
  if (Buffer.byteLength(path, "utf8") > MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("accounts broker socket path exceeds platform bound");
  }
  return path;
}
function readAccountsBrokerSecret(root) {
  const path = (0, import_node_path2.join)(assertBrokerRoot(root), ACCOUNTS_BROKER_SECRET_FILE);
  try {
    if (!(0, import_node_fs2.existsSync)(path)) return null;
    (0, import_state_store.assertPrivateRegularFile)(path, 512);
    const secret = Buffer.from((0, import_node_fs2.readFileSync)(path));
    if (secret.byteLength !== 32) {
      secret.fill(0);
      return null;
    }
    return secret;
  } catch {
    return null;
  }
}
async function startAccountsBrokerSocket(options) {
  const reservation = await reserveAccountsBrokerSocket(options);
  return reservation.activate({
    broker: options.broker,
    mapNativeTargets: options.mapNativeTargets,
    resolveNativeBrowserContext: options.resolveNativeBrowserContext,
    invokeNativeBrowserRequest: options.invokeNativeBrowserRequest,
    managerExecution: options.managerExecution
  });
}
async function reserveAccountsBrokerSocket(options) {
  const root = assertBrokerRoot(options.root);
  assertPrivateBrokerRoot(root);
  const electionLock = acquireProcessLock((0, import_node_path2.join)(root, ".accounts-broker-election.lock"));
  try {
    return await reserveAccountsBrokerSocketUnderLock(options);
  } finally {
    electionLock.release();
  }
}
async function reserveAccountsBrokerSocketUnderLock(options) {
  if (options.secret.byteLength !== 32) throw new Error("invalid accounts broker capability");
  const root = assertBrokerRoot(options.root);
  assertPrivateBrokerRoot(root);
  const socketFileName = options.socketFileName ?? ACCOUNTS_BROKER_SOCKET_FILE;
  const path = accountsBrokerSocketPath(root, socketFileName);
  (0, import_state_store.ensurePrivateDirectory)((0, import_node_path2.dirname)(path));
  const maxFrameBytes = boundedFrameBytes(options.maxFrameBytes ?? ACCOUNTS_BROKER_MAX_FRAME_BYTES);
  await removeStaleSocket(path);
  const connections = /* @__PURE__ */ new Set();
  let activation = null;
  const server = (0, import_node_net.createServer)((socket) => {
    socket.on("error", () => socket.destroy());
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.setNoDelay(true);
    if (!activation) {
      socket.destroy();
      return;
    }
    serveBrokerPeer(
      socket,
      activation.broker,
      options.secret,
      maxFrameBytes,
      activation.mapNativeTargets,
      activation.resolveNativeBrowserContext,
      activation.invokeNativeBrowserRequest,
      activation.managerExecution
    );
  });
  try {
    await listen(server, path);
    (0, import_node_fs2.chmodSync)(path, 384);
    assertPrivateSocket(path);
  } catch (error) {
    await closeServer(server, connections);
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    activation = null;
    await closeServer(server, connections);
    const electionLock = acquireProcessLock((0, import_node_path2.join)(root, ".accounts-broker-election.lock"));
    try {
      await removeStaleSocket(path);
      closed = true;
    } finally {
      electionLock.release();
    }
  };
  return {
    path,
    activate(activated) {
      if (closed || activation) throw new Error("accounts broker reservation is unavailable");
      activation = activated;
      return { path, close };
    },
    close
  };
}
function probeAccountsBrokerControlStatus(root, secret) {
  if (secret.byteLength !== 32) return Promise.resolve(false);
  const path = accountsBrokerSocketPath(root, ACCOUNTS_BROKER_CONTROL_SOCKET_FILE);
  try {
    assertPrivateSocket(path);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolvePromise) => {
    const socket = (0, import_node_net.createConnection)(path);
    const requestId = (0, import_node_crypto2.randomBytes)(12).toString("base64url");
    let buffered = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish(false), 2e3);
    timer.unref();
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: 1, method: "status", requestId, secret: secret.toString("base64url") })}
`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered, "utf8") > ACCOUNTS_BROKER_MAX_FRAME_BYTES) {
        finish(false);
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffered.slice(0, newline));
        finish((0, import_types.isPlainRecord)(response) && response.version === 1 && response.requestId === requestId && (0, import_types.isPlainRecord)(response.status) && response.status.version === 1 && response.status.state === "available");
      } catch {
        finish(false);
      }
    });
  });
}
async function startBrokerControlSocket(options) {
  if (options.secret.byteLength !== 32) throw new Error("invalid accounts broker capability");
  const root = assertBrokerRoot(options.root);
  (0, import_state_store.ensurePrivateDirectory)(root);
  const socketFileName = options.socketFileName ?? ACCOUNTS_BROKER_CONTROL_SOCKET_FILE;
  const path = accountsBrokerSocketPath(root, socketFileName);
  (0, import_state_store.ensurePrivateDirectory)((0, import_node_path2.dirname)(path));
  const maxFrameBytes = boundedFrameBytes(options.maxFrameBytes ?? ACCOUNTS_BROKER_MAX_FRAME_BYTES);
  await removeStaleSocket(path);
  const connections = /* @__PURE__ */ new Set();
  const server = (0, import_node_net.createServer)((socket) => {
    socket.on("error", () => socket.destroy());
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.setNoDelay(true);
    serveControlPeer(socket, options.secret, options.status, maxFrameBytes);
  });
  try {
    await listen(server, path);
    (0, import_node_fs2.chmodSync)(path, 384);
    assertPrivateSocket(path);
  } catch (error) {
    await closeServer(server, connections);
    await removeStaleSocket(path);
    throw error;
  }
  let closed = false;
  return {
    path,
    async close() {
      if (closed) return;
      closed = true;
      await closeServer(server, connections);
      await removeStaleSocket(path);
    }
  };
}
var AccountsBrokerManagerClientV1 = class {
  root;
  secret;
  socketFileName;
  maxFrameBytes;
  sockets = /* @__PURE__ */ new Set();
  closed = false;
  constructor(options) {
    this.root = assertBrokerRoot(options.root);
    if (options.secret.byteLength !== 32) throw new Error("invalid accounts broker manager capability");
    this.secret = Buffer.from(options.secret);
    this.socketFileName = options.socketFileName ?? ACCOUNTS_BROKER_SOCKET_FILE;
    this.maxFrameBytes = boundedFrameBytes(options.maxFrameBytes ?? ACCOUNTS_BROKER_MAX_FRAME_BYTES);
  }
  async prepareAuthenticationRecovery(requestId) {
    const request = { version: 1, action: "prepare_auth_recovery", requestId };
    if (!isDoctorExecutionLeaseRequest(request)) return false;
    return (await this.invoke(request)).status === "recovery_ready";
  }
  async acquireDoctorReviewLease(input) {
    const request = { version: 1, action: "acquire", ...input };
    if (!isDoctorExecutionLeaseRequest(request)) return managerUnavailable("invalid_request");
    const result = await this.invoke(request);
    return isDoctorExecutionAcquireResult(result) ? result : managerUnavailable("broker_unavailable");
  }
  async markDoctorReviewLeaseDispatched(input) {
    const request = { version: 1, action: "mark_dispatched", ...input };
    if (!isDoctorExecutionLeaseRequest(request)) return managerUnavailable("invalid_request");
    const result = await this.invoke(request);
    return isDoctorExecutionMarkResult(result) ? result : managerUnavailable("broker_unavailable");
  }
  async settleDoctorReviewLease(input) {
    const request = { version: 1, action: "settle", ...input };
    if (!isDoctorExecutionLeaseRequest(request)) return managerUnavailable("invalid_request");
    const result = await this.invoke(request);
    return isDoctorExecutionSettleResult(result) ? result : managerUnavailable("broker_unavailable");
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.secret.fill(0);
  }
  invoke(request) {
    if (this.closed) return Promise.resolve(managerUnavailable("broker_unavailable"));
    const path = accountsBrokerSocketPath(this.root, this.socketFileName);
    return new Promise((resolvePromise) => {
      const socket = (0, import_node_net.createConnection)(path);
      this.sockets.add(socket);
      let buffered = "", bytes = 0, settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.sockets.delete(socket);
        socket.destroy();
        resolvePromise(result);
      };
      timer = setTimeout(() => finish(managerUnavailable("broker_unavailable")), ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS);
      timer.unref();
      socket.once("error", () => finish(managerUnavailable("broker_unavailable")));
      socket.once("close", () => finish(managerUnavailable("broker_unavailable")));
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > this.maxFrameBytes * 2) return finish(managerUnavailable("broker_unavailable"));
        buffered += chunk;
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        if (buffered.slice(newline + 1).trim()) return finish(managerUnavailable("broker_unavailable"));
        try {
          const frame = JSON.parse(buffered.slice(0, newline));
          if (!isManagerExecutionResultFrame(frame) || frame.requestId !== request.requestId) return finish(managerUnavailable("broker_unavailable"));
          finish(frame.result);
        } catch {
          finish(managerUnavailable("broker_unavailable"));
        }
      });
      socket.once("connect", () => {
        const frame = {
          version: 1,
          kind: "manager-execution",
          request,
          proof: doctorExecutionProof(this.secret, request)
        };
        if (!writeManagerExecutionFrame(socket, frame, this.maxFrameBytes)) finish(managerUnavailable("broker_unavailable"));
      });
    });
  }
};
var AccountsBrokerSocketClientV1 = class {
  constructor(options) {
    this.options = options;
    if (options.secret.byteLength !== 32) throw new Error("invalid accounts broker capability");
    assertBrokerRoot(options.root);
    boundedFrameBytes(options.maxFrameBytes ?? ACCOUNTS_BROKER_MAX_FRAME_BYTES);
  }
  options;
  socket = null;
  connecting = null;
  closed = false;
  connected = false;
  pending = /* @__PURE__ */ new Map();
  pendingNativeMaps = /* @__PURE__ */ new Map();
  pendingNativeBrowser = /* @__PURE__ */ new Map();
  pendingNativeBrowserRequests = /* @__PURE__ */ new Map();
  subscribers = /* @__PURE__ */ new Set();
  buffered = "";
  byteLength = 0;
  async invoke(envelope) {
    if (this.closed) return unavailable(envelope.requestId);
    try {
      await this.ensureConnected();
    } catch {
      return unavailable(envelope.requestId);
    }
    const socket = this.socket;
    if (!socket || !this.connected) return unavailable(envelope.requestId);
    return new Promise((resolvePromise) => {
      if (this.pending.has(envelope.requestId)) {
        resolvePromise({ version: 1, requestId: envelope.requestId, ok: false, error: { code: "request_replayed", retryable: false } });
        return;
      }
      const timer = setTimeout(() => {
        const pending = this.pending.get(envelope.requestId);
        if (!pending) return;
        this.pending.delete(envelope.requestId);
        pending.resolve(unavailable(envelope.requestId));
      }, ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS);
      timer.unref();
      this.pending.set(envelope.requestId, { resolve: resolvePromise, timer, nativeScope: nativeRequestScope(envelope) });
      if (!writeFrame(socket, { version: 1, kind: "command", envelope }, this.frameBytes())) {
        const pending = this.pending.get(envelope.requestId);
        this.pending.delete(envelope.requestId);
        if (pending) clearTimeout(pending.timer);
        resolvePromise(unavailable(envelope.requestId));
      }
    });
  }
  /** Runtime-owned exact-ID mapping; it is intentionally not a broker command. */
  async mapNativeTargets(request) {
    if (!isNativeTargetMapRequest(request) || this.closed) return nativeUnavailable();
    try {
      await this.ensureConnected();
    } catch {
      return nativeUnavailable();
    }
    const socket = this.socket;
    if (!socket || !this.connected) return nativeUnavailable();
    const requestId = `native-map-${(0, import_node_crypto2.randomBytes)(12).toString("base64url")}`;
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        const pending = this.pendingNativeMaps.get(requestId);
        if (!pending) return;
        this.pendingNativeMaps.delete(requestId);
        pending.resolve(nativeUnavailable());
      }, ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS);
      timer.unref();
      this.pendingNativeMaps.set(requestId, { resolve: resolvePromise, timer });
      if (!writeOwnerFrame(socket, { version: 1, kind: "native-target-map", requestId, request }, this.frameBytes())) {
        const pending = this.pendingNativeMaps.get(requestId);
        this.pendingNativeMaps.delete(requestId);
        if (pending) clearTimeout(pending.timer);
        resolvePromise(nativeUnavailable());
      }
    });
  }
  async resolveNativeBrowserContext(opaqueAccountId) {
    if (!/^ar_[A-Za-z0-9_-]{16,128}$/.test(opaqueAccountId) || this.closed) return nativeBrowserUnavailable();
    try {
      await this.ensureConnected();
    } catch {
      return nativeBrowserUnavailable();
    }
    const socket = this.socket;
    if (!socket || !this.connected) return nativeBrowserUnavailable();
    const requestId = `native-browser-${(0, import_node_crypto2.randomBytes)(12).toString("base64url")}`;
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        const pending = this.pendingNativeBrowser.get(requestId);
        if (!pending) return;
        this.pendingNativeBrowser.delete(requestId);
        pending.resolve(nativeBrowserUnavailable());
      }, ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS);
      timer.unref();
      this.pendingNativeBrowser.set(requestId, { resolve: resolvePromise, timer });
      if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-context", requestId, opaqueAccountId }, this.frameBytes())) {
        const pending = this.pendingNativeBrowser.get(requestId);
        this.pendingNativeBrowser.delete(requestId);
        if (pending) clearTimeout(pending.timer);
        resolvePromise(nativeBrowserUnavailable());
      }
    });
  }
  async invokeNativeBrowserRequest(opaqueAccountId, method, params) {
    const request = (0, import_native_request.parseNativeBrowserChildRequestV1)(method, params);
    if (!/^ar_[A-Za-z0-9_-]{16,128}$/.test(opaqueAccountId) || !request || this.closed) return null;
    try {
      await this.ensureConnected();
    } catch {
      return null;
    }
    const socket = this.socket;
    if (!socket || !this.connected) return null;
    const requestId = `native-browser-rpc-${(0, import_node_crypto2.randomBytes)(12).toString("base64url")}`;
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        const pending = this.pendingNativeBrowserRequests.get(requestId);
        if (!pending) return;
        this.pendingNativeBrowserRequests.delete(requestId);
        pending.resolve(null);
      }, ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS);
      timer.unref();
      this.pendingNativeBrowserRequests.set(requestId, { resolve: resolvePromise, timer });
      if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-request", requestId, opaqueAccountId, ...request }, this.frameBytes())) {
        const pending = this.pendingNativeBrowserRequests.get(requestId);
        this.pendingNativeBrowserRequests.delete(requestId);
        if (pending) clearTimeout(pending.timer);
        resolvePromise(null);
      }
    });
  }
  subscribe(handler) {
    if (this.closed) return () => {
    };
    this.subscribers.add(handler);
    void this.ensureConnected().catch(() => {
    });
    return () => this.subscribers.delete(handler);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.failPending();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.subscribers.clear();
  }
  async ensureConnected() {
    if (this.closed) throw new Error("accounts broker client is closed");
    if (this.socket && this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
  open() {
    const path = accountsBrokerSocketPath(this.options.root, this.options.socketFileName ?? ACCOUNTS_BROKER_SOCKET_FILE);
    const maxFrameBytes = this.frameBytes();
    return new Promise((resolvePromise, reject) => {
      this.buffered = "";
      this.byteLength = 0;
      let settled = false;
      let handshakeTimer = null;
      const socket = (0, import_node_net.createConnection)(path);
      const settle = (error) => {
        if (settled) return;
        settled = true;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        if (error) reject(error);
        else resolvePromise();
      };
      const fail = () => {
        this.connected = false;
        if (this.socket === socket) this.socket = null;
        this.failPending();
        settle(new Error("accounts broker unavailable"));
      };
      socket.setNoDelay(true);
      socket.once("error", () => fail());
      socket.once("close", () => {
        this.connected = false;
        if (this.socket === socket) this.socket = null;
        this.failPending();
        if (!settled) settle(new Error("accounts broker unavailable"));
      });
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        if (this.socket !== socket) return;
        const receiveLimit = [...this.pending.values()].some((pending) => pending.nativeScope !== null) ? ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES : ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES;
        this.consumeFrameChunk(chunk, receiveLimit, (frame, frameBytes) => {
          if (frameBytes > ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES && (!isBrokerWireFrame(frame) || frame.kind !== "response" || !nativeResponseMatches(frame.response, this.pending.get(frame.response.requestId)?.nativeScope))) {
            socket.destroy();
            return;
          }
          if (!isBrokerWireFrame(frame)) {
            if (isNativeTargetResultFrame(frame)) {
              const pending = this.pendingNativeMaps.get(frame.requestId);
              if (!pending) return;
              this.pendingNativeMaps.delete(frame.requestId);
              clearTimeout(pending.timer);
              pending.resolve(frame.result);
              return;
            }
            if (isNativeBrowserContextResultFrame(frame)) {
              const pending = this.pendingNativeBrowser.get(frame.requestId);
              if (!pending) return;
              this.pendingNativeBrowser.delete(frame.requestId);
              clearTimeout(pending.timer);
              pending.resolve(frame.result);
              return;
            }
            if (isNativeBrowserRequestResultFrame(frame)) {
              const pending = this.pendingNativeBrowserRequests.get(frame.requestId);
              if (!pending) return;
              this.pendingNativeBrowserRequests.delete(frame.requestId);
              clearTimeout(pending.timer);
              pending.resolve(frame.result);
              return;
            }
            socket.destroy();
            return;
          }
          if (frame.kind === "handshake-result") {
            if (!frame.ok) {
              socket.destroy();
              settle(new Error("accounts broker rejected client"));
              return;
            }
            this.connected = true;
            settle();
            return;
          }
          if (frame.kind === "response") {
            const pending = this.pending.get(frame.response.requestId);
            if (!pending) return;
            if (pending.nativeScope && frame.response.ok && !nativeResponseMatches(frame.response, pending.nativeScope)) {
              socket.destroy();
              return;
            }
            this.pending.delete(frame.response.requestId);
            clearTimeout(pending.timer);
            pending.resolve(frame.response);
            return;
          }
          if (frame.kind === "event") {
            for (const handler of this.subscribers) {
              try {
                handler(frame.event);
              } catch {
              }
            }
          }
        });
      });
      socket.once("connect", () => {
        this.socket = socket;
        const unsigned = {
          version: 1,
          clientKind: this.options.clientKind,
          rendererRef: this.options.rendererRef,
          appToolsRef: this.options.appToolsRef,
          nonce: (0, import_node_crypto2.randomBytes)(24).toString("base64url")
        };
        const handshake = {
          ...unsigned,
          proof: (0, import_broker.createBrokerHandshakeProof)(this.options.secret, unsigned)
        };
        if (!writeFrame(socket, { version: 1, kind: "handshake", handshake }, maxFrameBytes)) {
          socket.destroy();
          return;
        }
        handshakeTimer = setTimeout(() => socket.destroy(), ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS);
        handshakeTimer.unref();
      });
    });
  }
  consumeFrameChunk(chunk, maxFrameBytes, onFrame) {
    const socket = this.socket;
    this.byteLength += Buffer.byteLength(chunk, "utf8");
    if (this.byteLength > maxFrameBytes * 2) {
      this.socket?.destroy();
      return;
    }
    this.buffered += chunk;
    while (true) {
      if (!socket || socket.destroyed || this.socket !== socket) return;
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      this.byteLength = Buffer.byteLength(this.buffered, "utf8");
      if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
        this.socket?.destroy();
        return;
      }
      try {
        onFrame(JSON.parse(line), Buffer.byteLength(line, "utf8"));
      } catch {
        this.socket?.destroy();
        return;
      }
    }
  }
  failPending() {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(unavailable(requestId));
    }
    this.pending.clear();
    for (const [requestId, pending] of this.pendingNativeMaps) {
      clearTimeout(pending.timer);
      pending.resolve(nativeUnavailable());
    }
    this.pendingNativeMaps.clear();
    for (const [requestId, pending] of this.pendingNativeBrowser) {
      clearTimeout(pending.timer);
      pending.resolve(nativeBrowserUnavailable());
    }
    this.pendingNativeBrowser.clear();
    for (const [, pending] of this.pendingNativeBrowserRequests) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingNativeBrowserRequests.clear();
  }
  frameBytes() {
    return boundedFrameBytes(this.options.maxFrameBytes ?? ACCOUNTS_BROKER_MAX_FRAME_BYTES);
  }
};
function serveBrokerPeer(socket, broker, secret, maxFrameBytes, mapNativeTargets, resolveNativeBrowserContext, invokeNativeBrowserRequest, managerExecution) {
  let buffered = "";
  let byteLength = 0;
  let rendererRef = null;
  let managerRequestConsumed = false;
  let unsubscribe = null;
  let releaseTransport = null;
  let handshakeTimer = setTimeout(() => socket.destroy(), ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref();
  const close = () => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    unsubscribe?.();
    unsubscribe = null;
    releaseTransport?.();
    releaseTransport = null;
  };
  socket.once("close", close);
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    if (managerRequestConsumed) {
      socket.destroy();
      return;
    }
    byteLength += Buffer.byteLength(chunk, "utf8");
    if (byteLength > maxFrameBytes * 2) {
      socket.destroy();
      return;
    }
    buffered += chunk;
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      byteLength -= Buffer.byteLength(line, "utf8") + 1;
      if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
        socket.destroy();
        return;
      }
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (!rendererRef) {
        if (isManagerExecutionRequestFrame(frame)) {
          if (buffered.trim().length > 0 || !managerExecution || !verifyDoctorExecutionProof(secret, frame.request, frame.proof)) {
            socket.destroy();
            return;
          }
          managerRequestConsumed = true;
          socket.pause();
          if (handshakeTimer) clearTimeout(handshakeTimer);
          handshakeTimer = null;
          void managerExecution(frame.request).then((result2) => {
            if (!isDoctorExecutionResultForRequest(frame.request, result2) || !writeManagerExecutionFrame(socket, { version: 1, kind: "manager-execution-result", requestId: frame.request.requestId, result: result2 }, maxFrameBytes)) {
              socket.destroy();
              return;
            }
            socket.end();
          }).catch(() => {
            writeManagerExecutionFrame(socket, {
              version: 1,
              kind: "manager-execution-result",
              requestId: frame.request.requestId,
              result: managerUnavailable("broker_unavailable")
            }, maxFrameBytes);
            socket.end();
          });
          return;
        }
        if (!isBrokerHandshakeFrame(frame)) {
          socket.destroy();
          return;
        }
        const result = broker.handshake(frame.handshake);
        if (!result.ok) {
          writeFrame(socket, { version: 1, kind: "handshake-result", ok: false, code: result.code ?? "unauthenticated" }, maxFrameBytes);
          socket.end();
          return;
        }
        rendererRef = frame.handshake.rendererRef;
        releaseTransport = broker.retainRendererTransport(rendererRef);
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        if (!writeFrame(socket, { version: 1, kind: "handshake-result", ok: true, pool: result.pool }, maxFrameBytes)) return;
        unsubscribe = broker.subscribe(rendererRef, (event) => {
          try {
            (0, import_broker.assertBrokerRedacted)(event);
            if (!writeFrame(socket, { version: 1, kind: "event", event }, ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES)) socket.destroy();
          } catch {
            socket.destroy();
          }
        });
        continue;
      }
      if (isNativeTargetMapFrame(frame)) {
        const result = mapNativeTargets?.(rendererRef, frame.request) ?? nativeUnavailable();
        if (!writeOwnerFrame(socket, { version: 1, kind: "native-target-result", requestId: frame.requestId, result }, maxFrameBytes)) socket.destroy();
        continue;
      }
      if (isNativeBrowserContextFrame(frame)) {
        void broker.withActiveOperation(() => resolveNativeBrowserContext?.(rendererRef, frame.opaqueAccountId) ?? Promise.resolve(nativeBrowserUnavailable())).then((result) => {
          if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-context-result", requestId: frame.requestId, result }, maxFrameBytes)) socket.destroy();
        }).catch(() => {
          if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-context-result", requestId: frame.requestId, result: nativeBrowserUnavailable() }, maxFrameBytes)) socket.destroy();
        });
        continue;
      }
      if (isNativeBrowserRequestFrame(frame)) {
        void broker.withActiveOperation(() => invokeNativeBrowserRequest?.(rendererRef, frame.opaqueAccountId, frame.method, frame.params) ?? Promise.resolve(null)).then((result) => {
          if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-request-result", requestId: frame.requestId, result }, ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES)) socket.destroy();
        }).catch(() => {
          if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-request-result", requestId: frame.requestId, result: null }, maxFrameBytes)) socket.destroy();
        });
        continue;
      }
      if (!isBrokerCommandFrame(frame)) {
        socket.destroy();
        return;
      }
      void broker.invoke(rendererRef, frame.envelope).then((response) => {
        try {
          if (response.ok) (0, import_broker.assertBrokerCommandResult)(frame.envelope.command, response.result);
          else (0, import_broker.assertBrokerRedacted)(response);
          const nativeScope = nativeRequestScope(frame.envelope);
          if (nativeScope && response.ok && !nativeResponseMatches(response, nativeScope)) throw new Error("native response account mismatch");
          const responseLimit = nativeScope && response.ok ? ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES : ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES;
          if (!writeFrame(socket, { version: 1, kind: "response", response }, responseLimit, frame.envelope.command)) socket.destroy();
        } catch {
          socket.destroy();
        }
      });
    }
  });
}
function serveControlPeer(socket, secret, status, maxFrameBytes) {
  let byteLength = 0;
  let buffered = "";
  let terminal = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    if (terminal) return;
    byteLength += Buffer.byteLength(chunk, "utf8");
    if (byteLength > maxFrameBytes) {
      terminal = true;
      socket.destroy();
      return;
    }
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline < 0) return;
    const frame = buffered.slice(0, newline);
    const remainder = buffered.slice(newline + 1);
    terminal = true;
    if (remainder.trim().length > 0 || Buffer.byteLength(frame, "utf8") > maxFrameBytes) {
      socket.destroy();
      return;
    }
    const request = parseControlRequest(frame);
    if (!request || !matchesSecret(request.secret, secret)) {
      socket.end();
      return;
    }
    try {
      const projection = status();
      (0, import_redaction.assertRedacted)(projection);
      const response = { version: 1, requestId: request.requestId, status: projection };
      const encoded = Buffer.from(`${JSON.stringify(response)}
`, "utf8");
      if (encoded.byteLength > maxFrameBytes) {
        socket.destroy();
        return;
      }
      socket.end(encoded);
    } catch {
      socket.destroy();
    }
  });
}
function isBrokerHandshakeFrame(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["handshake", "kind", "version"].join("\0") && value.version === 1 && value.kind === "handshake" && (0, import_types.isPlainRecord)(value.handshake);
}
function isBrokerCommandFrame(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["envelope", "kind", "version"].join("\0") && value.version === 1 && value.kind === "command" && (0, import_types.isPlainRecord)(value.envelope);
}
function isBrokerWireFrame(value) {
  if (!(0, import_types.isPlainRecord)(value) || value.version !== 1 || typeof value.kind !== "string") return false;
  if (value.kind === "handshake-result") {
    return value.ok === true || value.ok === false && (value.code === "incompatible_client" || value.code === "unauthenticated");
  }
  if (value.kind === "response") return (0, import_types.isPlainRecord)(value.response) && typeof value.response.requestId === "string" && typeof value.response.ok === "boolean";
  if (value.kind === "event") return (0, import_types.isPlainRecord)(value.event) && value.event.version === 1 && typeof value.event.sequence === "number" && typeof value.event.type === "string";
  return false;
}
function parseControlRequest(frame) {
  try {
    const value = JSON.parse(frame);
    if (!(0, import_types.isPlainRecord)(value) || Object.keys(value).sort().join("\0") !== ["method", "requestId", "secret", "version"].join("\0")) return null;
    if (value.version !== 1 || value.method !== "status" || typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId) || typeof value.secret !== "string" || value.secret.length > 128) return null;
    return { requestId: value.requestId, secret: value.secret };
  } catch {
    return null;
  }
}
function nativeRequestScope(envelope) {
  const value = envelope.params;
  if (envelope.command !== "native.request" || !(0, import_types.isPlainRecord)(value) || Object.keys(value).sort().join("\0") !== "method\0opaqueAccountId\0params\0surface" || typeof value.opaqueAccountId !== "string" || !/^ar_[A-Za-z0-9_-]{43}$/.test(value.opaqueAccountId)) return null;
  const request = (0, import_native_request.parseNativeRequestV1)({ method: value.method, surface: value.surface, params: value.params });
  return request ? { opaqueAccountId: value.opaqueAccountId, surface: request.surface } : null;
}
function nativeResponseMatches(response, scope) {
  return Boolean(scope && response.ok && (0, import_types.isPlainRecord)(response.result) && Object.keys(response.result).sort().join("\0") === "opaqueAccountId\0result\0surface" && response.result.opaqueAccountId === scope.opaqueAccountId && response.result.surface === scope.surface && (0, import_native_request.isBoundedNativeResultV1)(response.result.result, scope.surface));
}
function writeFrame(socket, frame, maxFrameBytes, command) {
  try {
    if ((command === "profile.email" || command === "native.request") && frame.kind === "response" && frame.response.ok) {
      (0, import_broker.assertBrokerCommandResult)(command, frame.response.result);
      (0, import_broker.assertBrokerRedacted)({ ...frame, response: { ...frame.response, result: null } });
    } else (0, import_broker.assertBrokerRedacted)(frame);
    const encoded = Buffer.from(`${JSON.stringify(frame)}
`, "utf8");
    if (encoded.byteLength > maxFrameBytes) return false;
    if (!socket.writable) return false;
    socket.write(encoded);
    return true;
  } catch {
    return false;
  }
}
function writeOwnerFrame(socket, frame, maxFrameBytes) {
  try {
    if (frame.kind === "native-target-map") {
      if (!isNativeTargetMapRequest(frame.request) || !safeNativeMapRequestId(frame.requestId)) return false;
    } else if (frame.kind === "native-target-result") {
      if (!isNativeTargetMapResult(frame.result) || !safeNativeMapRequestId(frame.requestId)) return false;
    } else if (frame.kind === "native-browser-context") {
      if (!safeNativeMapRequestId(frame.requestId) || !/^ar_[A-Za-z0-9_-]{16,128}$/.test(frame.opaqueAccountId)) return false;
    } else if (frame.kind === "native-browser-context-result") {
      if (!safeNativeMapRequestId(frame.requestId) || !isNativeBrowserContext(frame.result)) return false;
    } else if (frame.kind === "native-browser-request") {
      if (!safeNativeMapRequestId(frame.requestId) || !/^ar_[A-Za-z0-9_-]{16,128}$/.test(frame.opaqueAccountId) || !(0, import_native_request.parseNativeBrowserChildRequestV1)(frame.method, frame.params)) return false;
    } else if (frame.kind === "native-browser-request-result") {
      if (!safeNativeMapRequestId(frame.requestId) || !(0, import_native_request.isBoundedNativeResultV1)(frame.result, "plugins")) return false;
    } else {
      (0, import_broker.assertBrokerRedacted)(frame);
    }
    const encoded = Buffer.from(`${JSON.stringify(frame)}
`, "utf8");
    if (encoded.byteLength > maxFrameBytes || !socket.writable) return false;
    socket.write(encoded);
    return true;
  } catch {
    return false;
  }
}
function isNativeTargetMapFrame(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "request", "requestId", "version"].join("\0") && value.version === 1 && value.kind === "native-target-map" && safeNativeMapRequestId(value.requestId) && isNativeTargetMapRequest(value.request);
}
function isNativeTargetResultFrame(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "requestId", "result", "version"].join("\0") && value.version === 1 && value.kind === "native-target-result" && safeNativeMapRequestId(value.requestId) && isNativeTargetMapResult(value.result);
}
function isNativeBrowserContextFrame(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "opaqueAccountId", "requestId", "version"].join("\0") && value.version === 1 && value.kind === "native-browser-context" && safeNativeMapRequestId(value.requestId) && typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{16,128}$/.test(value.opaqueAccountId);
}
function isNativeBrowserContextResultFrame(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "requestId", "result", "version"].join("\0") && value.version === 1 && value.kind === "native-browser-context-result" && safeNativeMapRequestId(value.requestId) && isNativeBrowserContext(value.result);
}
function isNativeBrowserRequestFrame(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "method", "opaqueAccountId", "params", "requestId", "version"].join("\0") && value.version === 1 && value.kind === "native-browser-request" && safeNativeMapRequestId(value.requestId) && typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{16,128}$/.test(value.opaqueAccountId) && (0, import_native_request.parseNativeBrowserChildRequestV1)(value.method, value.params) !== null;
}
function isNativeBrowserRequestResultFrame(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "requestId", "result", "version"].join("\0") && value.version === 1 && value.kind === "native-browser-request-result" && safeNativeMapRequestId(value.requestId) && (0, import_native_request.isBoundedNativeResultV1)(value.result, "plugins");
}
function isManagerExecutionRequestFrame(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === "kind\0proof\0request\0version" && value.version === 1 && value.kind === "manager-execution" && typeof value.proof === "string" && /^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(value.proof) && isDoctorExecutionLeaseRequest(value.request);
}
function isManagerExecutionResultFrame(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === "kind\0requestId\0result\0version" && value.version === 1 && value.kind === "manager-execution-result" && isDoctorExecutionRequestId(value.requestId) && isDoctorExecutionLeaseResult(value.result);
}
function isDoctorExecutionLeaseRequest(value) {
  if (!(0, import_types.isPlainRecord)(value) || value.version !== 1 || !isDoctorExecutionRequestId(value.requestId)) return false;
  if (value.action === "prepare_auth_recovery") return Object.keys(value).sort().join() === "action,requestId,version";
  if (value.action === "acquire") return Object.keys(value).sort().join("\0") === "action\0estimatedCost\0purpose\0requestId\0version" && value.purpose === "doctor_review" && Number.isSafeInteger(value.estimatedCost) && Number(value.estimatedCost) >= 1 && Number(value.estimatedCost) <= 1e6;
  if (value.action === "mark_dispatched") return Object.keys(value).sort().join("\0") === "action\0leaseId\0requestId\0version" && isDoctorExecutionLeaseId(value.leaseId);
  if (value.action === "settle") {
    const allowed = /* @__PURE__ */ new Set(["action", "leaseId", "outcome", "requestId", "usage", "version"]);
    if (Object.keys(value).some((key) => !allowed.has(key)) || !isDoctorExecutionLeaseId(value.leaseId) || !["pre_dispatch", "completed", "ambiguous"].includes(String(value.outcome))) return false;
    if (value.outcome === "completed") return isDoctorExecutionUsage(value.usage);
    return value.usage === void 0;
  }
  return false;
}
function isDoctorExecutionLeaseResult(value) {
  return (0, import_types.isPlainRecord)(value) && value.status === "recovery_ready" && Object.keys(value).join() === "status" || isDoctorExecutionAcquireResult(value) || isDoctorExecutionMarkResult(value) || isDoctorExecutionSettleResult(value);
}
function isDoctorExecutionAcquireResult(value) {
  if (!(0, import_types.isPlainRecord)(value)) return false;
  if (value.status === "unavailable") return isManagerUnavailable(value);
  return value.status === "ready" && Object.keys(value).sort().join("\0") === "codexHome\0leaseId\0opaqueAccountId\0status" && isDoctorExecutionLeaseId(value.leaseId) && typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value.opaqueAccountId) && typeof value.codexHome === "string" && (0, import_node_path2.isAbsolute)(value.codexHome) && (0, import_node_path2.resolve)(value.codexHome) === value.codexHome;
}
function isDoctorExecutionMarkResult(value) {
  return (0, import_types.isPlainRecord)(value) && (value.status === "unavailable" ? isManagerUnavailable(value) : value.status === "dispatched" && Object.keys(value).sort().join("\0") === "leaseId\0status" && isDoctorExecutionLeaseId(value.leaseId));
}
function isDoctorExecutionSettleResult(value) {
  return (0, import_types.isPlainRecord)(value) && (value.status === "unavailable" ? isManagerUnavailable(value) : value.status === "settled" && Object.keys(value).sort().join("\0") === "leaseId\0outcome\0status" && isDoctorExecutionLeaseId(value.leaseId) && ["pre_dispatch", "completed", "ambiguous"].includes(String(value.outcome)));
}
function isDoctorExecutionResultForRequest(request, result) {
  if ((0, import_types.isPlainRecord)(result) && result.status === "unavailable") return isManagerUnavailable(result);
  if (request.action === "prepare_auth_recovery") return (0, import_types.isPlainRecord)(result) && result.status === "recovery_ready" && Object.keys(result).join() === "status";
  return request.action === "acquire" ? isDoctorExecutionAcquireResult(result) : request.action === "mark_dispatched" ? isDoctorExecutionMarkResult(result) : isDoctorExecutionSettleResult(result) && result.status === "settled" && result.outcome === request.outcome;
}
function isManagerUnavailable(value) {
  return Object.keys(value).sort().join("\0") === "reason\0status" && value.status === "unavailable" && ["broker_unavailable", "pool_depleted", "quota_unavailable", "binding_unavailable", "request_replayed", "invalid_request"].includes(String(value.reason));
}
function managerUnavailable(reason) {
  return { status: "unavailable", reason };
}
function doctorExecutionProof(secret, request) {
  const normalized = request.action === "prepare_auth_recovery" ? { version: 1, requestId: request.requestId, action: request.action } : request.action === "acquire" ? { version: 1, requestId: request.requestId, action: request.action, purpose: request.purpose, estimatedCost: request.estimatedCost } : request.action === "mark_dispatched" ? { version: 1, requestId: request.requestId, action: request.action, leaseId: request.leaseId } : { version: 1, requestId: request.requestId, action: request.action, leaseId: request.leaseId, outcome: request.outcome, ...request.usage ? { usage: request.usage } : {} };
  return `hmac-sha256:${(0, import_node_crypto2.createHmac)("sha256", secret).update(`manager-execution:v1:${JSON.stringify(normalized)}`, "utf8").digest("base64url")}`;
}
function verifyDoctorExecutionProof(secret, request, proof) {
  try {
    const expected = Buffer.from(doctorExecutionProof(secret, request));
    const actual = Buffer.from(proof);
    return expected.byteLength === actual.byteLength && (0, import_node_crypto2.timingSafeEqual)(expected, actual);
  } catch {
    return false;
  }
}
function writeManagerExecutionFrame(socket, frame, maxFrameBytes) {
  try {
    if (frame.kind === "manager-execution") {
      if (!isDoctorExecutionLeaseRequest(frame.request) || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(frame.proof)) return false;
    } else if (!isDoctorExecutionRequestId(frame.requestId) || !isDoctorExecutionLeaseResult(frame.result)) return false;
    const encoded = Buffer.from(`${JSON.stringify(frame)}
`, "utf8");
    if (encoded.byteLength > maxFrameBytes || !socket.writable) return false;
    socket.write(encoded);
    return true;
  } catch {
    return false;
  }
}
function isDoctorExecutionRequestId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isDoctorExecutionLeaseId(value) {
  return typeof value === "string" && /^rs_[A-Za-z0-9_-]{16,64}$/.test(value);
}
function isDoctorExecutionUsage(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === "inputTokens\0outputTokens" && Number.isSafeInteger(value.inputTokens) && Number(value.inputTokens) >= 0 && Number.isSafeInteger(value.outputTokens) && Number(value.outputTokens) >= 0;
}
function isNativeBrowserContext(value) {
  if (!(0, import_types.isPlainRecord)(value) || value.version !== 1) return false;
  if (value.status === "unavailable") return Object.keys(value).sort().join("\0") === "status\0version";
  if (value.status !== "ready" || Object.keys(value).some((key) => !["appServerVersion", "codexHome", "configFile", "opaqueAccountId", "status", "version"].includes(key))) return false;
  return typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{16,128}$/.test(value.opaqueAccountId) && typeof value.codexHome === "string" && (0, import_node_path2.isAbsolute)(value.codexHome) && (0, import_node_path2.resolve)(value.codexHome) === value.codexHome && typeof value.configFile === "string" && value.configFile === (0, import_node_path2.join)(value.codexHome, "config.toml") && typeof value.appServerVersion === "string" && value.appServerVersion.length > 0 && value.appServerVersion.length <= 128;
}
function isNativeTargetMapRequest(value) {
  return (0, import_types.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["assistantTurnNativeIds", "composerNativeId", "conversationNativeId", "version"].join("\0") && value.version === 1 && validNativeTargetId(value.conversationNativeId) && validNativeTargetId(value.composerNativeId) && Array.isArray(value.assistantTurnNativeIds) && value.assistantTurnNativeIds.length <= 128 && value.assistantTurnNativeIds.every(validNativeTargetId);
}
function isNativeTargetMapResult(value) {
  return (0, import_types.isPlainRecord)(value) && value.version === 1 && (value.status === "unavailable" ? Object.keys(value).length === 3 : value.status === "mapped" && typeof value.conversationId === "string" && /^conversation_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId) && Array.isArray(value.turnIds) && value.turnIds.length <= 128 && value.turnIds.every((turnId) => typeof turnId === "string" && /^turn_[A-Za-z0-9_-]{16,128}$/.test(turnId)));
}
function nativeUnavailable() {
  return { version: 1, status: "unavailable" };
}
function nativeBrowserUnavailable() {
  return { version: 1, status: "unavailable" };
}
function safeNativeMapRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
function validNativeTargetId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
function unavailable(requestId) {
  return { version: 1, requestId, ok: false, error: { code: "broker_unavailable", retryable: true } };
}
function assertBrokerRoot(root) {
  if (typeof root !== "string" || !(0, import_node_path2.isAbsolute)(root) || (0, import_node_path2.resolve)(root) !== root) throw new Error("invalid accounts broker root");
  return root;
}
function assertPrivateBrokerRoot(root) {
  const stat = (0, import_node_fs2.lstatSync)(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 63) !== 0) {
    throw new Error("accounts broker root is not owner-private");
  }
}
function validateSocketFileName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 48 || value !== value.trim() || /[^A-Za-z0-9._-]/.test(value) || value.includes("..")) {
    throw new Error("unsafe accounts broker socket name");
  }
}
function boundedFrameBytes(value) {
  if (!Number.isInteger(value) || value < 512 || value > 64 * 1024) throw new Error("invalid accounts broker frame bound");
  return value;
}
function matchesSecret(serialized, secret) {
  const candidate = Buffer.alloc(secret.byteLength);
  let decoded;
  try {
    decoded = Buffer.from(serialized, "base64url");
    if (decoded.byteLength === secret.byteLength && decoded.toString("base64url") === serialized) decoded.copy(candidate);
    return (0, import_node_crypto2.timingSafeEqual)(candidate, secret);
  } finally {
    decoded?.fill(0);
    candidate.fill(0);
  }
}
function assertPrivateSocket(path) {
  const stat = (0, import_node_fs2.lstatSync)(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 63) !== 0) {
    throw new Error("accounts broker socket is not owner-private");
  }
}
async function removeStaleSocket(path) {
  if (!(0, import_node_fs2.existsSync)(path)) return;
  assertPrivateSocket(path);
  if (await socketIsLive(path)) throw new Error("accounts broker socket is already active");
  (0, import_node_fs2.unlinkSync)(path);
}
function socketIsLive(path) {
  return new Promise((resolvePromise) => {
    const socket = (0, import_node_net.createConnection)(path);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}
function listen(server, path) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}
async function closeServer(server, connections) {
  for (const socket of connections) socket.destroy();
  if (!server.listening) return;
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
}
function accountsBrokerRootHash(root) {
  return (0, import_node_crypto2.createHash)("sha256").update(assertBrokerRoot(root), "utf8").digest("hex").slice(0, 24);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS,
  ACCOUNTS_BROKER_CONTROL_SOCKET_FILE,
  ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS,
  ACCOUNTS_BROKER_MAX_FRAME_BYTES,
  ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES,
  ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES,
  ACCOUNTS_BROKER_SECRET_FILE,
  ACCOUNTS_BROKER_SOCKET_FILE,
  AccountsBrokerManagerClientV1,
  AccountsBrokerSocketClientV1,
  accountsBrokerConfigPath,
  accountsBrokerRootHash,
  accountsBrokerSocketPath,
  probeAccountsBrokerControlStatus,
  readAccountsBrokerSecret,
  reserveAccountsBrokerSocket,
  resolveAccountsBrokerRoot,
  resolveAccountsBrokerRootResolution,
  startAccountsBrokerSocket,
  startBrokerControlSocket
});
//# sourceMappingURL=broker-socket.js.map

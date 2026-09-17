import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AccountsBrokerV1, assertBrokerCommandResult, assertBrokerRedacted, createBrokerHandshakeProof } from "./broker";
import type { NativeSharedHistoryMapRequestV1, NativeSharedHistoryMapResultV1 } from "./broker-host";
import { routerControlSocketPath } from "./control-socket";
import { assertRedacted } from "./redaction";
import { assertPrivateRegularFile, ensurePrivateDirectory } from "./state-store";
import { isBoundedNativeResultV1, parseNativeBrowserChildRequestV1, parseNativeRequestV1, NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES } from "./native-request";
import type {
  AccountPoolV3,
  BrokerClientKind,
  BrokerControlStatusV1,
  BrokerEventV1,
  BrokerHandshakeV1,
  BrokerRequestEnvelopeV1,
  BrokerResponseV1,
  OpaqueAppToolsRef,
  OpaqueRendererRef,
} from "./types";
import { isPlainRecord } from "./types";

export const ACCOUNTS_BROKER_SOCKET_FILE = "accounts-broker.v1.sock";
export const ACCOUNTS_BROKER_CONTROL_SOCKET_FILE = "broker-control.v1.sock";
export const ACCOUNTS_BROKER_SECRET_FILE = "control-secret.v1";
export const ACCOUNTS_BROKER_MAX_FRAME_BYTES = 16 * 1024;
/** Bounded, schema-validated projections may contain the full connection catalog. */
export const ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES = 1024 * 1024;
/** Only a correlated, validated native response may use this payload plus envelope budget. */
export const ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES = NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES + 16 * 1024;
export const ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS = 5_000;
/** A command is never replayed after this owner-private response deadline. */
export const ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS = 15_000;

const MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 100;

export interface AccountsBrokerRootResolutionOptions {
  userRoot: string | undefined;
  derivedVariant: boolean;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Main needs to distinguish an absent global-root setting from an explicit
 * value that failed validation. The latter must remain fail-closed all the
 * way through app-server parent selection; it is not permission to use a
 * local account-router configuration.
 */
export interface AccountsBrokerRootResolution {
  root: string | null;
  configured: boolean;
}

/**
 * Resolve the only root allowed to own cross-app broker state.  Every desktop
 * must receive the explicit manager-global rendezvous root; deriving from an
 * app-local user root could elect two owners with separate ledgers.
 */
export function resolveAccountsBrokerRootResolution(
  options: AccountsBrokerRootResolutionOptions,
): AccountsBrokerRootResolution {
  const environment = options.environment ?? process.env;
  const primary = environment.TWEAKERS_ACCOUNTS_BROKER_ROOT;
  const compatibility = environment.TWEAKER_ACCOUNTS_BROKER_ROOT;
  const primaryConfigured = primary !== undefined;
  const compatibilityConfigured = compatibility !== undefined;
  if (!primaryConfigured && !compatibilityConfigured) return { root: null, configured: false };

  // The aliases are two spellings for the one manager-global rendezvous root.
  // Do not silently choose one alias when they differ, including when one is
  // malformed and the other happens to be valid.
  if (primaryConfigured && compatibilityConfigured && primary !== compatibility) {
    return { root: null, configured: true };
  }
  const explicit = primaryConfigured ? primary : compatibility;
  if (!isCanonicalAccountsBrokerRoot(explicit)) return { root: null, configured: true };
  return { root: explicit, configured: true };
}

/** Compatibility projection for callers that only need the valid root. */
export function resolveAccountsBrokerRoot(options: AccountsBrokerRootResolutionOptions): string | null {
  return resolveAccountsBrokerRootResolution(options).root;
}

function isCanonicalAccountsBrokerRoot(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value) && resolve(value) === value;
}

export function accountsBrokerConfigPath(root: string): string {
  const resolved = assertBrokerRoot(root);
  return join(resolved, "account-router-config.json");
}

export function accountsBrokerSocketPath(root: string, socketFileName = ACCOUNTS_BROKER_SOCKET_FILE): string {
  validateSocketFileName(socketFileName);
  const path = routerControlSocketPath(assertBrokerRoot(root), socketFileName);
  if (Buffer.byteLength(path, "utf8") > MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("accounts broker socket path exceeds platform bound");
  }
  return path;
}

/** Read the exact owner-private capability shared by the global broker host. */
export function readAccountsBrokerSecret(root: string): Buffer | null {
  const path = join(assertBrokerRoot(root), ACCOUNTS_BROKER_SECRET_FILE);
  try {
    if (!existsSync(path)) return null;
    assertPrivateRegularFile(path, 512);
    const secret = Buffer.from(readFileSync(path));
    if (secret.byteLength !== 32) {
      secret.fill(0);
      return null;
    }
    return secret;
  } catch {
    return null;
  }
}

export interface AccountsBrokerSocket {
  readonly path: string;
  close(): Promise<void>;
}

/**
 * A bound but not yet serving owner-election endpoint.  Holding this
 * reservation is the only authority to initialize the global broker root.
 * It deliberately accepts no broker work until the elected owner has
 * finished its owner-private recovery.
 */
export interface AccountsBrokerSocketReservation {
  readonly path: string;
  activate(options: Pick<AccountsBrokerSocketOptions, "broker" | "mapNativeTargets" | "resolveNativeBrowserContext" | "invokeNativeBrowserRequest" | "managerExecution">): AccountsBrokerSocket;
  close(): Promise<void>;
}

export interface AccountsBrokerSocketOptions {
  root: string;
  broker: AccountsBrokerV1;
  secret: Buffer;
  socketFileName?: string;
  maxFrameBytes?: number;
  /** Reserved runtime-owned mapping path; deliberately absent from BrokerCommandV1. */
  mapNativeTargets?: (rendererRef: OpaqueRendererRef, request: NativeSharedHistoryMapRequestV1) => NativeSharedHistoryMapResultV1;
  resolveNativeBrowserContext?: (rendererRef: OpaqueRendererRef, opaqueAccountId: string) => Promise<NativeBrowserContextV1>;
  invokeNativeBrowserRequest?: (rendererRef: OpaqueRendererRef, opaqueAccountId: string, method: string, params: Record<string, unknown>) => Promise<unknown | null>;
  managerExecution?: (request: DoctorExecutionLeaseRequestV1) => Promise<DoctorExecutionLeaseResultV1>;
}

export type DoctorExecutionLeaseUnavailableReason = "broker_unavailable" | "pool_depleted" | "quota_unavailable" | "binding_unavailable" | "request_replayed" | "invalid_request";
export type DoctorExecutionLeaseAcquireResultV1 =
  | { status: "ready"; leaseId: string; opaqueAccountId: string; codexHome: string }
  | { status: "unavailable"; reason: DoctorExecutionLeaseUnavailableReason };
export type DoctorExecutionLeaseMarkResultV1 =
  | { status: "dispatched"; leaseId: string }
  | { status: "unavailable"; reason: DoctorExecutionLeaseUnavailableReason };
export type DoctorExecutionLeaseSettleResultV1 =
  | { status: "settled"; leaseId: string; outcome: "pre_dispatch" | "completed" | "ambiguous" }
  | { status: "unavailable"; reason: DoctorExecutionLeaseUnavailableReason };
export type DoctorExecutionLeaseRequestV1 =
  | { version: 1; requestId: string; action: "prepare_auth_recovery" }
  | { version: 1; requestId: string; action: "acquire"; purpose: "doctor_review"; estimatedCost: number }
  | { version: 1; requestId: string; action: "mark_dispatched"; leaseId: string }
  | { version: 1; requestId: string; action: "settle"; leaseId: string; outcome: "pre_dispatch" | "completed" | "ambiguous"; usage?: { inputTokens: number; outputTokens: number } };
export type DoctorExecutionLeaseResultV1 = { status: "recovery_ready" } | DoctorExecutionLeaseAcquireResultV1 | DoctorExecutionLeaseMarkResultV1 | DoctorExecutionLeaseSettleResultV1;

export type NativeBrowserContextV1 = { version: 1; status: "unavailable" } | {
  version: 1; status: "ready"; opaqueAccountId: string; codexHome: string; configFile: string; appServerVersion: string;
};

type BrokerWireFrame =
  | { version: 1; kind: "handshake"; handshake: BrokerHandshakeV1 }
  | { version: 1; kind: "command"; envelope: BrokerRequestEnvelopeV1 }
  | { version: 1; kind: "handshake-result"; ok: true; pool: AccountPoolV3 }
  | { version: 1; kind: "handshake-result"; ok: false; code: "incompatible_client" | "unauthenticated" }
  | { version: 1; kind: "response"; response: BrokerResponseV1 }
  | { version: 1; kind: "event"; event: BrokerEventV1 };

type NativeTargetWireFrame =
  | { version: 1; kind: "native-target-map"; requestId: string; request: NativeSharedHistoryMapRequestV1 }
  | { version: 1; kind: "native-target-result"; requestId: string; result: NativeSharedHistoryMapResultV1 };

type NativeBrowserWireFrame =
  | { version: 1; kind: "native-browser-context"; requestId: string; opaqueAccountId: string }
  | { version: 1; kind: "native-browser-context-result"; requestId: string; result: NativeBrowserContextV1 }
  | { version: 1; kind: "native-browser-request"; requestId: string; opaqueAccountId: string; method: string; params: Record<string, unknown> }
  | { version: 1; kind: "native-browser-request-result"; requestId: string; result: unknown | null };

type OwnerWireFrame = BrokerWireFrame | NativeTargetWireFrame | NativeBrowserWireFrame;
type ManagerExecutionWireFrame =
  | { version: 1; kind: "manager-execution"; request: DoctorExecutionLeaseRequestV1; proof: string }
  | { version: 1; kind: "manager-execution-result"; requestId: string; result: DoctorExecutionLeaseResultV1 };

/**
 * A single owner-private, authenticated broker endpoint.  Each peer must
 * prove a fresh opaque renderer/app-tools session before sending a command.
 * JSONL is bounded and every event remains targeted by the broker itself.
 */
export async function startAccountsBrokerSocket(options: AccountsBrokerSocketOptions): Promise<AccountsBrokerSocket> {
  const reservation = await reserveAccountsBrokerSocket(options);
  return reservation.activate({ broker: options.broker, mapNativeTargets: options.mapNativeTargets,
    resolveNativeBrowserContext: options.resolveNativeBrowserContext, invokeNativeBrowserRequest: options.invokeNativeBrowserRequest,
    managerExecution: options.managerExecution });
}

/**
 * Bind the owner-election socket before touching any shared broker state.
 * A contender that cannot bind this endpoint has no authority to recover or
 * mutate the shared root.  While reserved, early client connections are
 * closed so their normal bounded retry can find the activated owner.
 */
export async function reserveAccountsBrokerSocket(
  options: Pick<AccountsBrokerSocketOptions, "root" | "secret" | "socketFileName" | "maxFrameBytes">,
): Promise<AccountsBrokerSocketReservation> {
  if (options.secret.byteLength !== 32) throw new Error("invalid accounts broker capability");
  const root = assertBrokerRoot(options.root);
  assertPrivateBrokerRoot(root);
  const socketFileName = options.socketFileName ?? ACCOUNTS_BROKER_SOCKET_FILE;
  const path = accountsBrokerSocketPath(root, socketFileName);
  ensurePrivateDirectory(dirname(path));
  const maxFrameBytes = boundedFrameBytes(options.maxFrameBytes ?? ACCOUNTS_BROKER_MAX_FRAME_BYTES);
  await removeStaleSocket(path);

  const connections = new Set<Socket>();
  let activation: Pick<AccountsBrokerSocketOptions, "broker" | "mapNativeTargets" | "resolveNativeBrowserContext" | "invokeNativeBrowserRequest" | "managerExecution"> | null = null;
  const server = createServer((socket) => {
    // A peer can disappear after writable was checked but before the OS
    // completes a handshake/event write. Its async error belongs to this
    // connection, including connections arriving before owner activation.
    socket.on("error", () => socket.destroy());
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.setNoDelay(true);
    if (!activation) {
      socket.destroy();
      return;
    }
    serveBrokerPeer(socket, activation.broker, options.secret, maxFrameBytes, activation.mapNativeTargets, activation.resolveNativeBrowserContext,
      activation.invokeNativeBrowserRequest, activation.managerExecution);
  });
  try {
    await listen(server, path);
    chmodSync(path, 0o600);
    assertPrivateSocket(path);
  } catch (error) {
    await closeServer(server, connections);
    // Do not unlink here: a concurrent winner may own the path that caused
    // this contender's bind to fail.
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    activation = null;
    await closeServer(server, connections);
    await removeStaleSocket(path);
  };
  return {
    path,
    activate(activated): AccountsBrokerSocket {
      if (closed || activation) throw new Error("accounts broker reservation is unavailable");
      activation = activated;
      return { path, close };
    },
    close,
  };
}

export interface BrokerControlSocket {
  readonly path: string;
  close(): Promise<void>;
}

export interface BrokerControlSocketOptions {
  root: string;
  secret: Buffer;
  status: () => BrokerControlStatusV1;
  socketFileName?: string;
  maxFrameBytes?: number;
}

/**
 * One-shot status endpoint.  Its exact successful response is
 * `{version:1,requestId,status:BrokerControlStatusV1}`; malformed or
 * unauthenticated requests receive no status projection.
 */
export async function startBrokerControlSocket(options: BrokerControlSocketOptions): Promise<BrokerControlSocket> {
  if (options.secret.byteLength !== 32) throw new Error("invalid accounts broker capability");
  const root = assertBrokerRoot(options.root);
  ensurePrivateDirectory(root);
  const socketFileName = options.socketFileName ?? ACCOUNTS_BROKER_CONTROL_SOCKET_FILE;
  const path = accountsBrokerSocketPath(root, socketFileName);
  ensurePrivateDirectory(dirname(path));
  const maxFrameBytes = boundedFrameBytes(options.maxFrameBytes ?? ACCOUNTS_BROKER_MAX_FRAME_BYTES);
  await removeStaleSocket(path);
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.setNoDelay(true);
    serveControlPeer(socket, options.secret, options.status, maxFrameBytes);
  });
  try {
    await listen(server, path);
    chmodSync(path, 0o600);
    assertPrivateSocket(path);
  } catch (error) {
    await closeServer(server, connections);
    await removeStaleSocket(path);
    throw error;
  }
  let closed = false;
  return {
    path,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeServer(server, connections);
      await removeStaleSocket(path);
    },
  };
}

export interface AccountsBrokerSocketClientOptions {
  root: string;
  secret: Buffer;
  clientKind: BrokerClientKind;
  rendererRef: OpaqueRendererRef;
  appToolsRef: OpaqueAppToolsRef;
  socketFileName?: string;
  maxFrameBytes?: number;
}

export interface AccountsBrokerManagerClientOptions {
  root: string;
  secret: Buffer;
  socketFileName?: string;
  maxFrameBytes?: number;
}

/** Owner-private manager client. Each operation uses one authenticated frame and is never replayed by the transport. */
export class AccountsBrokerManagerClientV1 {
  private readonly root: string;
  private readonly secret: Buffer;
  private readonly socketFileName: string;
  private readonly maxFrameBytes: number;
  private readonly sockets = new Set<Socket>();
  private closed = false;

  constructor(options: AccountsBrokerManagerClientOptions) {
    this.root = assertBrokerRoot(options.root);
    if (options.secret.byteLength !== 32) throw new Error("invalid accounts broker manager capability");
    this.secret = Buffer.from(options.secret);
    this.socketFileName = options.socketFileName ?? ACCOUNTS_BROKER_SOCKET_FILE;
    this.maxFrameBytes = boundedFrameBytes(options.maxFrameBytes ?? ACCOUNTS_BROKER_MAX_FRAME_BYTES);
  }

  async prepareAuthenticationRecovery(requestId: string): Promise<boolean> {
    const request = { version: 1 as const, action: "prepare_auth_recovery" as const, requestId };
    if (!isDoctorExecutionLeaseRequest(request)) return false;
    return (await this.invoke(request)).status === "recovery_ready";
  }

  async acquireDoctorReviewLease(input: { requestId: string; purpose: "doctor_review"; estimatedCost: number }): Promise<DoctorExecutionLeaseAcquireResultV1> {
    const request = { version: 1 as const, action: "acquire" as const, ...input };
    if (!isDoctorExecutionLeaseRequest(request)) return managerUnavailable("invalid_request");
    const result = await this.invoke(request);
    return isDoctorExecutionAcquireResult(result) ? result : managerUnavailable("broker_unavailable");
  }

  async markDoctorReviewLeaseDispatched(input: { requestId: string; leaseId: string }): Promise<DoctorExecutionLeaseMarkResultV1> {
    const request = { version: 1 as const, action: "mark_dispatched" as const, ...input };
    if (!isDoctorExecutionLeaseRequest(request)) return managerUnavailable("invalid_request");
    const result = await this.invoke(request);
    return isDoctorExecutionMarkResult(result) ? result : managerUnavailable("broker_unavailable");
  }

  async settleDoctorReviewLease(input: { requestId: string; leaseId: string; outcome: "pre_dispatch" | "completed" | "ambiguous"; usage?: { inputTokens: number; outputTokens: number } }): Promise<DoctorExecutionLeaseSettleResultV1> {
    const request = { version: 1 as const, action: "settle" as const, ...input };
    if (!isDoctorExecutionLeaseRequest(request)) return managerUnavailable("invalid_request");
    const result = await this.invoke(request);
    return isDoctorExecutionSettleResult(result) ? result : managerUnavailable("broker_unavailable");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.secret.fill(0);
  }

  private invoke(request: DoctorExecutionLeaseRequestV1): Promise<DoctorExecutionLeaseResultV1> {
    if (this.closed) return Promise.resolve(managerUnavailable("broker_unavailable"));
    const path = accountsBrokerSocketPath(this.root, this.socketFileName);
    return new Promise((resolvePromise) => {
      const socket = createConnection(path);
      this.sockets.add(socket);
      let buffered = "", bytes = 0, settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: DoctorExecutionLeaseResultV1): void => {
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
      socket.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > this.maxFrameBytes * 2) return finish(managerUnavailable("broker_unavailable"));
        buffered += chunk;
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        if (buffered.slice(newline + 1).trim()) return finish(managerUnavailable("broker_unavailable"));
        try {
          const frame = JSON.parse(buffered.slice(0, newline)) as unknown;
          if (!isManagerExecutionResultFrame(frame) || frame.requestId !== request.requestId) return finish(managerUnavailable("broker_unavailable"));
          finish(frame.result);
        } catch { finish(managerUnavailable("broker_unavailable")); }
      });
      socket.once("connect", () => {
        const frame: ManagerExecutionWireFrame = { version: 1, kind: "manager-execution", request,
          proof: doctorExecutionProof(this.secret, request) };
        if (!writeManagerExecutionFrame(socket, frame, this.maxFrameBytes)) finish(managerUnavailable("broker_unavailable"));
      });
    });
  }
}

/**
 * Main-process-only client.  It never retries a command after a connection
 * loss: the owner consumed its request id before execution, so automatic
 * replay could duplicate a handoff or any later mutating operation.
 */
export class AccountsBrokerSocketClientV1 {
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private connected = false;
  private pending = new Map<string, { resolve(response: BrokerResponseV1): void; timer: ReturnType<typeof setTimeout>; nativeScope: NativeResponseScope | null }>();
  private pendingNativeMaps = new Map<string, { resolve(result: NativeSharedHistoryMapResultV1): void; timer: ReturnType<typeof setTimeout> }>();
  private pendingNativeBrowser = new Map<string, { resolve(result: NativeBrowserContextV1): void; timer: ReturnType<typeof setTimeout> }>();
  private pendingNativeBrowserRequests = new Map<string, { resolve(result: unknown | null): void; timer: ReturnType<typeof setTimeout> }>();
  private subscribers = new Set<(event: BrokerEventV1) => void>();
  private buffered = "";
  private byteLength = 0;

  constructor(private readonly options: AccountsBrokerSocketClientOptions) {
    if (options.secret.byteLength !== 32) throw new Error("invalid accounts broker capability");
    assertBrokerRoot(options.root);
    boundedFrameBytes(options.maxFrameBytes ?? ACCOUNTS_BROKER_MAX_FRAME_BYTES);
  }

  async invoke(envelope: BrokerRequestEnvelopeV1): Promise<BrokerResponseV1> {
    if (this.closed) return unavailable(envelope.requestId);
    try {
      await this.ensureConnected();
    } catch {
      return unavailable(envelope.requestId);
    }
    const socket = this.socket;
    if (!socket || !this.connected) return unavailable(envelope.requestId);
    return new Promise<BrokerResponseV1>((resolvePromise) => {
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
  async mapNativeTargets(request: NativeSharedHistoryMapRequestV1): Promise<NativeSharedHistoryMapResultV1> {
    if (!isNativeTargetMapRequest(request) || this.closed) return nativeUnavailable();
    try { await this.ensureConnected(); } catch { return nativeUnavailable(); }
    const socket = this.socket;
    if (!socket || !this.connected) return nativeUnavailable();
    const requestId = `native-map-${randomBytes(12).toString("base64url")}`;
    return new Promise<NativeSharedHistoryMapResultV1>((resolvePromise) => {
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

  async resolveNativeBrowserContext(opaqueAccountId: string): Promise<NativeBrowserContextV1> {
    if (!/^ar_[A-Za-z0-9_-]{16,128}$/.test(opaqueAccountId) || this.closed) return nativeBrowserUnavailable();
    try { await this.ensureConnected(); } catch { return nativeBrowserUnavailable(); }
    const socket = this.socket;
    if (!socket || !this.connected) return nativeBrowserUnavailable();
    const requestId = `native-browser-${randomBytes(12).toString("base64url")}`;
    return new Promise<NativeBrowserContextV1>((resolvePromise) => {
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

  async invokeNativeBrowserRequest(opaqueAccountId: string, method: string, params: Record<string, unknown>): Promise<unknown | null> {
    const request = parseNativeBrowserChildRequestV1(method, params);
    if (!/^ar_[A-Za-z0-9_-]{16,128}$/.test(opaqueAccountId) || !request || this.closed) return null;
    try { await this.ensureConnected(); } catch { return null; }
    const socket = this.socket;
    if (!socket || !this.connected) return null;
    const requestId = `native-browser-rpc-${randomBytes(12).toString("base64url")}`;
    return new Promise<unknown | null>((resolvePromise) => {
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

  subscribe(handler: (event: BrokerEventV1) => void): () => void {
    if (this.closed) return () => {};
    this.subscribers.add(handler);
    // Subscription is intentionally non-blocking for the main tweak API. A
    // later invoke reconnects after an unavailable owner; no command is sent
    // here and therefore no mutating action can be replayed.
    void this.ensureConnected().catch(() => {});
    return () => this.subscribers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failPending();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.subscribers.clear();
  }

  private async ensureConnected(): Promise<void> {
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

  private open(): Promise<void> {
    const path = accountsBrokerSocketPath(this.options.root, this.options.socketFileName ?? ACCOUNTS_BROKER_SOCKET_FILE);
    const maxFrameBytes = this.frameBytes();
    return new Promise<void>((resolvePromise, reject) => {
      // A failed connection may have ended in the middle of a JSONL frame.
      // Never let those bytes become a prefix on the next authenticated peer.
      this.buffered = "";
      this.byteLength = 0;
      let settled = false;
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
      const socket = createConnection(path);
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        if (error) reject(error);
        else resolvePromise();
      };
      const fail = (): void => {
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
      socket.on("data", (chunk: string) => {
        if (this.socket !== socket) return;
        const receiveLimit = [...this.pending.values()].some((pending) => pending.nativeScope !== null)
          ? ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES : ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES;
        this.consumeFrameChunk(chunk, receiveLimit, (frame, frameBytes) => {
          if (frameBytes > ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES && (!isBrokerWireFrame(frame) || frame.kind !== "response"
            || !nativeResponseMatches(frame.response, this.pending.get(frame.response.requestId)?.nativeScope))) {
            socket.destroy(); return;
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
              socket.destroy(); return;
            }
            this.pending.delete(frame.response.requestId);
            clearTimeout(pending.timer);
            pending.resolve(frame.response);
            return;
          }
          if (frame.kind === "event") {
            for (const handler of this.subscribers) {
              try { handler(frame.event); } catch { /* observer isolation */ }
            }
          }
        });
      });
      socket.once("connect", () => {
        this.socket = socket;
        const unsigned = {
          version: 1 as const,
          clientKind: this.options.clientKind,
          rendererRef: this.options.rendererRef,
          appToolsRef: this.options.appToolsRef,
          nonce: randomBytes(24).toString("base64url"),
        };
        const handshake: BrokerHandshakeV1 = {
          ...unsigned,
          proof: createBrokerHandshakeProof(this.options.secret, unsigned),
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

  private consumeFrameChunk(chunk: string, maxFrameBytes: number, onFrame: (frame: unknown, frameBytes: number) => void): void {
    const socket = this.socket;
    this.byteLength += Buffer.byteLength(chunk, "utf8");
    if (this.byteLength > maxFrameBytes * 2) {
      this.socket?.destroy();
      return;
    }
    this.buffered += chunk;
    while (true) {
      // A semantic rejection may destroy the socket inside onFrame. Do not
      // dispatch any later frames already buffered from that rejected peer.
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
      try { onFrame(JSON.parse(line) as unknown, Buffer.byteLength(line, "utf8")); } catch { this.socket?.destroy(); return; }
    }
  }

  private failPending(): void {
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

  private frameBytes(): number {
    return boundedFrameBytes(this.options.maxFrameBytes ?? ACCOUNTS_BROKER_MAX_FRAME_BYTES);
  }
}

function serveBrokerPeer(socket: Socket, broker: AccountsBrokerV1, secret: Buffer, maxFrameBytes: number,
  mapNativeTargets?: AccountsBrokerSocketOptions["mapNativeTargets"],
  resolveNativeBrowserContext?: AccountsBrokerSocketOptions["resolveNativeBrowserContext"],
  invokeNativeBrowserRequest?: AccountsBrokerSocketOptions["invokeNativeBrowserRequest"],
  managerExecution?: AccountsBrokerSocketOptions["managerExecution"]): void {
  let buffered = "";
  let byteLength = 0;
  let rendererRef: OpaqueRendererRef | null = null;
  let managerRequestConsumed = false;
  let unsubscribe: (() => void) | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => socket.destroy(), ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref();
  const close = (): void => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  socket.once("close", close);
  socket.on("data", (chunk: Buffer) => {
    if (managerRequestConsumed) { socket.destroy(); return; }
    byteLength += chunk.byteLength;
    if (byteLength > maxFrameBytes * 2) {
      socket.destroy();
      return;
    }
    buffered += chunk.toString("utf8");
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      byteLength = Buffer.byteLength(buffered, "utf8");
      if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
        socket.destroy();
        return;
      }
      let frame: unknown;
      try { frame = JSON.parse(line) as unknown; } catch { socket.destroy(); return; }
      if (!rendererRef) {
        if (isManagerExecutionRequestFrame(frame)) {
          if (buffered.trim().length > 0 || !managerExecution || !verifyDoctorExecutionProof(secret, frame.request, frame.proof)) { socket.destroy(); return; }
          managerRequestConsumed = true;
          socket.pause();
          if (handshakeTimer) clearTimeout(handshakeTimer);
          handshakeTimer = null;
          void managerExecution(frame.request).then((result) => {
            if (!isDoctorExecutionResultForRequest(frame.request, result)
              || !writeManagerExecutionFrame(socket, { version: 1, kind: "manager-execution-result", requestId: frame.request.requestId, result }, maxFrameBytes)) {
              socket.destroy(); return;
            }
            socket.end();
          }).catch(() => {
            writeManagerExecutionFrame(socket, { version: 1, kind: "manager-execution-result", requestId: frame.request.requestId,
              result: managerUnavailable("broker_unavailable") }, maxFrameBytes);
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
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        if (!writeFrame(socket, { version: 1, kind: "handshake-result", ok: true, pool: result.pool! }, maxFrameBytes)) return;
        unsubscribe = broker.subscribe(rendererRef, (event) => {
          try {
            assertBrokerRedacted(event);
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
        void (resolveNativeBrowserContext?.(rendererRef, frame.opaqueAccountId) ?? Promise.resolve(nativeBrowserUnavailable())).then((result) => {
          if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-context-result", requestId: frame.requestId, result }, maxFrameBytes)) socket.destroy();
        }).catch(() => {
          if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-context-result", requestId: frame.requestId, result: nativeBrowserUnavailable() }, maxFrameBytes)) socket.destroy();
        });
        continue;
      }
      if (isNativeBrowserRequestFrame(frame)) {
        void (invokeNativeBrowserRequest?.(rendererRef, frame.opaqueAccountId, frame.method, frame.params) ?? Promise.resolve(null)).then((result) => {
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
          if (response.ok) assertBrokerCommandResult(frame.envelope.command, response.result);
          else assertBrokerRedacted(response);
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

function serveControlPeer(
  socket: Socket,
  secret: Buffer,
  status: () => BrokerControlStatusV1,
  maxFrameBytes: number,
): void {
  let byteLength = 0;
  let buffered = "";
  let terminal = false;
  socket.on("data", (chunk: Buffer) => {
    if (terminal) return;
    byteLength += chunk.byteLength;
    if (byteLength > maxFrameBytes) {
      terminal = true;
      socket.destroy();
      return;
    }
    buffered += chunk.toString("utf8");
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
      assertRedacted(projection);
      const response = { version: 1 as const, requestId: request.requestId, status: projection };
      const encoded = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
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

function isBrokerHandshakeFrame(value: unknown): value is Extract<BrokerWireFrame, { kind: "handshake" }> {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["handshake", "kind", "version"].join("\0")
    && value.version === 1 && value.kind === "handshake" && isPlainRecord(value.handshake);
}

function isBrokerCommandFrame(value: unknown): value is Extract<BrokerWireFrame, { kind: "command" }> {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["envelope", "kind", "version"].join("\0")
    && value.version === 1 && value.kind === "command" && isPlainRecord(value.envelope);
}

function isBrokerWireFrame(value: unknown): value is BrokerWireFrame {
  if (!isPlainRecord(value) || value.version !== 1 || typeof value.kind !== "string") return false;
  if (value.kind === "handshake-result") {
    return value.ok === true || (value.ok === false && (value.code === "incompatible_client" || value.code === "unauthenticated"));
  }
  if (value.kind === "response") return isPlainRecord(value.response) && typeof value.response.requestId === "string" && typeof value.response.ok === "boolean";
  if (value.kind === "event") return isPlainRecord(value.event) && value.event.version === 1 && typeof value.event.sequence === "number" && typeof value.event.type === "string";
  return false;
}

function parseControlRequest(frame: string): { requestId: string; secret: string } | null {
  try {
    const value = JSON.parse(frame) as unknown;
    if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["method", "requestId", "secret", "version"].join("\0")) return null;
    if (value.version !== 1 || value.method !== "status" || typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)
      || typeof value.secret !== "string" || value.secret.length > 128) return null;
    return { requestId: value.requestId, secret: value.secret };
  } catch {
    return null;
  }
}

type NativeResponseScope = { opaqueAccountId: string; surface: string };

function nativeRequestScope(envelope: BrokerRequestEnvelopeV1): NativeResponseScope | null {
  const value = envelope.params;
  if (envelope.command !== "native.request" || !isPlainRecord(value)
    || Object.keys(value).sort().join("\0") !== "method\0opaqueAccountId\0params\0surface"
    || typeof value.opaqueAccountId !== "string" || !/^ar_[A-Za-z0-9_-]{43}$/.test(value.opaqueAccountId)) return null;
  const request = parseNativeRequestV1({ method: value.method, surface: value.surface, params: value.params });
  return request ? { opaqueAccountId: value.opaqueAccountId, surface: request.surface } : null;
}

function nativeResponseMatches(response: BrokerResponseV1, scope: NativeResponseScope | null | undefined): boolean {
  return Boolean(scope && response.ok && isPlainRecord(response.result)
    && Object.keys(response.result).sort().join("\0") === "opaqueAccountId\0result\0surface"
    && response.result.opaqueAccountId === scope.opaqueAccountId && response.result.surface === scope.surface
    && isBoundedNativeResultV1(response.result.result, scope.surface as never));
}

function writeFrame(socket: Socket, frame: BrokerWireFrame, maxFrameBytes: number, command?: string): boolean {
  try {
    // Broker profile projections intentionally carry a strictly masked email
    // (for example `abc***@example.test`); the generic control redactor
    // rejects every @-bearing value. Control status continues to use that
    // generic rule, while authenticated broker frames use the narrow broker
    // exception already enforced by the broker itself. Validated native tool
    // schemas likewise stay response-only: their field names may describe
    // authorization inputs without being account credentials.
    if ((command === "profile.email" || command === "native.request") && frame.kind === "response" && frame.response.ok) {
      assertBrokerCommandResult(command, frame.response.result);
      assertBrokerRedacted({ ...frame, response: { ...frame.response, result: null } });
    } else assertBrokerRedacted(frame);
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (encoded.byteLength > maxFrameBytes) return false;
    if (!socket.writable) return false;
    socket.write(encoded);
    return true;
  } catch {
    return false;
  }
}

function writeOwnerFrame(socket: Socket, frame: OwnerWireFrame, maxFrameBytes: number): boolean {
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
      if (!safeNativeMapRequestId(frame.requestId) || !/^ar_[A-Za-z0-9_-]{16,128}$/.test(frame.opaqueAccountId)
        || !parseNativeBrowserChildRequestV1(frame.method, frame.params)) return false;
    } else if (frame.kind === "native-browser-request-result") {
      if (!safeNativeMapRequestId(frame.requestId) || !isBoundedNativeResultV1(frame.result, "plugins")) return false;
    } else {
      assertBrokerRedacted(frame);
    }
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (encoded.byteLength > maxFrameBytes || !socket.writable) return false;
    socket.write(encoded);
    return true;
  } catch { return false; }
}

function isNativeTargetMapFrame(value: unknown): value is Extract<NativeTargetWireFrame, { kind: "native-target-map" }> {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["kind", "request", "requestId", "version"].join("\0")
    && value.version === 1 && value.kind === "native-target-map" && safeNativeMapRequestId(value.requestId) && isNativeTargetMapRequest(value.request);
}

function isNativeTargetResultFrame(value: unknown): value is Extract<NativeTargetWireFrame, { kind: "native-target-result" }> {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["kind", "requestId", "result", "version"].join("\0")
    && value.version === 1 && value.kind === "native-target-result" && safeNativeMapRequestId(value.requestId) && isNativeTargetMapResult(value.result);
}

function isNativeBrowserContextFrame(value: unknown): value is Extract<NativeBrowserWireFrame, { kind: "native-browser-context" }> {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["kind", "opaqueAccountId", "requestId", "version"].join("\0")
    && value.version === 1 && value.kind === "native-browser-context" && safeNativeMapRequestId(value.requestId)
    && typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{16,128}$/.test(value.opaqueAccountId);
}

function isNativeBrowserContextResultFrame(value: unknown): value is Extract<NativeBrowserWireFrame, { kind: "native-browser-context-result" }> {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["kind", "requestId", "result", "version"].join("\0")
    && value.version === 1 && value.kind === "native-browser-context-result" && safeNativeMapRequestId(value.requestId)
    && isNativeBrowserContext(value.result);
}

function isNativeBrowserRequestFrame(value: unknown): value is Extract<NativeBrowserWireFrame, { kind: "native-browser-request" }> {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["kind", "method", "opaqueAccountId", "params", "requestId", "version"].join("\0")
    && value.version === 1 && value.kind === "native-browser-request" && safeNativeMapRequestId(value.requestId)
    && typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{16,128}$/.test(value.opaqueAccountId)
    && parseNativeBrowserChildRequestV1(value.method, value.params) !== null;
}

function isNativeBrowserRequestResultFrame(value: unknown): value is Extract<NativeBrowserWireFrame, { kind: "native-browser-request-result" }> {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["kind", "requestId", "result", "version"].join("\0")
    && value.version === 1 && value.kind === "native-browser-request-result" && safeNativeMapRequestId(value.requestId)
    && isBoundedNativeResultV1(value.result, "plugins");
}

function isManagerExecutionRequestFrame(value: unknown): value is Extract<ManagerExecutionWireFrame, { kind: "manager-execution" }> {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === "kind\0proof\0request\0version"
    && value.version === 1 && value.kind === "manager-execution" && typeof value.proof === "string"
    && /^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(value.proof) && isDoctorExecutionLeaseRequest(value.request);
}

function isManagerExecutionResultFrame(value: unknown): value is Extract<ManagerExecutionWireFrame, { kind: "manager-execution-result" }> {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === "kind\0requestId\0result\0version"
    && value.version === 1 && value.kind === "manager-execution-result" && isDoctorExecutionRequestId(value.requestId)
    && isDoctorExecutionLeaseResult(value.result);
}

function isDoctorExecutionLeaseRequest(value: unknown): value is DoctorExecutionLeaseRequestV1 {
  if (!isPlainRecord(value) || value.version !== 1 || !isDoctorExecutionRequestId(value.requestId)) return false;
  if (value.action === "prepare_auth_recovery") return Object.keys(value).sort().join() === "action,requestId,version";
  if (value.action === "acquire") return Object.keys(value).sort().join("\0") === "action\0estimatedCost\0purpose\0requestId\0version"
    && value.purpose === "doctor_review" && Number.isSafeInteger(value.estimatedCost) && Number(value.estimatedCost) >= 1 && Number(value.estimatedCost) <= 1_000_000;
  if (value.action === "mark_dispatched") return Object.keys(value).sort().join("\0") === "action\0leaseId\0requestId\0version"
    && isDoctorExecutionLeaseId(value.leaseId);
  if (value.action === "settle") {
    const allowed = new Set(["action", "leaseId", "outcome", "requestId", "usage", "version"]);
    if (Object.keys(value).some((key) => !allowed.has(key)) || !isDoctorExecutionLeaseId(value.leaseId)
      || !["pre_dispatch", "completed", "ambiguous"].includes(String(value.outcome))) return false;
    if (value.outcome === "completed") return isDoctorExecutionUsage(value.usage);
    return value.usage === undefined;
  }
  return false;
}

function isDoctorExecutionLeaseResult(value: unknown): value is DoctorExecutionLeaseResultV1 {
  return (isPlainRecord(value) && value.status === "recovery_ready" && Object.keys(value).join() === "status") || isDoctorExecutionAcquireResult(value) || isDoctorExecutionMarkResult(value) || isDoctorExecutionSettleResult(value);
}

function isDoctorExecutionAcquireResult(value: unknown): value is DoctorExecutionLeaseAcquireResultV1 {
  if (!isPlainRecord(value)) return false;
  if (value.status === "unavailable") return isManagerUnavailable(value);
  return value.status === "ready" && Object.keys(value).sort().join("\0") === "codexHome\0leaseId\0opaqueAccountId\0status"
    && isDoctorExecutionLeaseId(value.leaseId) && typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value.opaqueAccountId)
    && typeof value.codexHome === "string" && isAbsolute(value.codexHome) && resolve(value.codexHome) === value.codexHome;
}

function isDoctorExecutionMarkResult(value: unknown): value is DoctorExecutionLeaseMarkResultV1 {
  return isPlainRecord(value) && (value.status === "unavailable" ? isManagerUnavailable(value)
    : value.status === "dispatched" && Object.keys(value).sort().join("\0") === "leaseId\0status" && isDoctorExecutionLeaseId(value.leaseId));
}

function isDoctorExecutionSettleResult(value: unknown): value is DoctorExecutionLeaseSettleResultV1 {
  return isPlainRecord(value) && (value.status === "unavailable" ? isManagerUnavailable(value)
    : value.status === "settled" && Object.keys(value).sort().join("\0") === "leaseId\0outcome\0status"
      && isDoctorExecutionLeaseId(value.leaseId) && ["pre_dispatch", "completed", "ambiguous"].includes(String(value.outcome)));
}

function isDoctorExecutionResultForRequest(request: DoctorExecutionLeaseRequestV1, result: unknown): result is DoctorExecutionLeaseResultV1 {
  if (isPlainRecord(result) && result.status === "unavailable") return isManagerUnavailable(result);
  if (request.action === "prepare_auth_recovery") return isPlainRecord(result) && result.status === "recovery_ready" && Object.keys(result).join() === "status";
  return request.action === "acquire" ? isDoctorExecutionAcquireResult(result)
    : request.action === "mark_dispatched" ? isDoctorExecutionMarkResult(result)
      : isDoctorExecutionSettleResult(result) && result.status === "settled" && result.outcome === request.outcome;
}

function isManagerUnavailable(value: Record<string, unknown>): value is { status: "unavailable"; reason: DoctorExecutionLeaseUnavailableReason } {
  return Object.keys(value).sort().join("\0") === "reason\0status" && value.status === "unavailable"
    && ["broker_unavailable", "pool_depleted", "quota_unavailable", "binding_unavailable", "request_replayed", "invalid_request"].includes(String(value.reason));
}

function managerUnavailable(reason: DoctorExecutionLeaseUnavailableReason): { status: "unavailable"; reason: DoctorExecutionLeaseUnavailableReason } {
  return { status: "unavailable", reason };
}

function doctorExecutionProof(secret: Buffer, request: DoctorExecutionLeaseRequestV1): string {
  const normalized = request.action === "prepare_auth_recovery" ? { version: 1, requestId: request.requestId, action: request.action } : request.action === "acquire"
    ? { version: 1, requestId: request.requestId, action: request.action, purpose: request.purpose, estimatedCost: request.estimatedCost }
    : request.action === "mark_dispatched"
      ? { version: 1, requestId: request.requestId, action: request.action, leaseId: request.leaseId }
      : { version: 1, requestId: request.requestId, action: request.action, leaseId: request.leaseId, outcome: request.outcome, ...(request.usage ? { usage: request.usage } : {}) };
  return `hmac-sha256:${createHmac("sha256", secret).update(`manager-execution:v1:${JSON.stringify(normalized)}`, "utf8").digest("base64url")}`;
}

function verifyDoctorExecutionProof(secret: Buffer, request: DoctorExecutionLeaseRequestV1, proof: string): boolean {
  try {
    const expected = Buffer.from(doctorExecutionProof(secret, request));
    const actual = Buffer.from(proof);
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  } catch { return false; }
}

function writeManagerExecutionFrame(socket: Socket, frame: ManagerExecutionWireFrame, maxFrameBytes: number): boolean {
  try {
    if (frame.kind === "manager-execution") {
      if (!isDoctorExecutionLeaseRequest(frame.request) || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(frame.proof)) return false;
    } else if (!isDoctorExecutionRequestId(frame.requestId) || !isDoctorExecutionLeaseResult(frame.result)) return false;
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (encoded.byteLength > maxFrameBytes || !socket.writable) return false;
    socket.write(encoded);
    return true;
  } catch { return false; }
}

function isDoctorExecutionRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isDoctorExecutionLeaseId(value: unknown): value is string { return typeof value === "string" && /^rs_[A-Za-z0-9_-]{16,64}$/.test(value); }
function isDoctorExecutionUsage(value: unknown): value is { inputTokens: number; outputTokens: number } {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === "inputTokens\0outputTokens"
    && Number.isSafeInteger(value.inputTokens) && Number(value.inputTokens) >= 0
    && Number.isSafeInteger(value.outputTokens) && Number(value.outputTokens) >= 0;
}

function isNativeBrowserContext(value: unknown): value is NativeBrowserContextV1 {
  if (!isPlainRecord(value) || value.version !== 1) return false;
  if (value.status === "unavailable") return Object.keys(value).sort().join("\0") === "status\0version";
  if (value.status !== "ready" || Object.keys(value).some((key) => !["appServerVersion", "codexHome", "configFile", "opaqueAccountId", "status", "version"].includes(key))) return false;
  return typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{16,128}$/.test(value.opaqueAccountId)
    && typeof value.codexHome === "string" && isAbsolute(value.codexHome) && resolve(value.codexHome) === value.codexHome
    && typeof value.configFile === "string" && value.configFile === join(value.codexHome, "config.toml")
    && typeof value.appServerVersion === "string" && value.appServerVersion.length > 0 && value.appServerVersion.length <= 128;
}

function isNativeTargetMapRequest(value: unknown): value is NativeSharedHistoryMapRequestV1 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["assistantTurnNativeIds", "composerNativeId", "conversationNativeId", "version"].join("\0")
    && value.version === 1 && validNativeTargetId(value.conversationNativeId) && validNativeTargetId(value.composerNativeId)
    && Array.isArray(value.assistantTurnNativeIds) && value.assistantTurnNativeIds.length <= 128 && value.assistantTurnNativeIds.every(validNativeTargetId);
}

function isNativeTargetMapResult(value: unknown): value is NativeSharedHistoryMapResultV1 {
  return isPlainRecord(value) && value.version === 1 && (value.status === "unavailable" ? Object.keys(value).length === 3
    : value.status === "mapped" && typeof value.conversationId === "string" && /^conversation_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId)
      && Array.isArray(value.turnIds) && value.turnIds.length <= 128 && value.turnIds.every((turnId) => typeof turnId === "string" && /^turn_[A-Za-z0-9_-]{16,128}$/.test(turnId)));
}

function nativeUnavailable(): NativeSharedHistoryMapResultV1 { return { version: 1, status: "unavailable" }; }
function nativeBrowserUnavailable(): NativeBrowserContextV1 { return { version: 1, status: "unavailable" }; }
function safeNativeMapRequestId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value); }
function validNativeTargetId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value); }

function unavailable(requestId: string): BrokerResponseV1 {
  return { version: 1, requestId, ok: false, error: { code: "broker_unavailable", retryable: true } };
}

function assertBrokerRoot(root: string): string {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) throw new Error("invalid accounts broker root");
  return root;
}

/** Read-only validation for owner election. Election must not chmod or mkdir the shared root. */
function assertPrivateBrokerRoot(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("accounts broker root is not owner-private");
  }
}

function validateSocketFileName(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 48 || value !== value.trim() || /[^A-Za-z0-9._-]/.test(value) || value.includes("..")) {
    throw new Error("unsafe accounts broker socket name");
  }
}

function boundedFrameBytes(value: number): number {
  if (!Number.isInteger(value) || value < 512 || value > 64 * 1024) throw new Error("invalid accounts broker frame bound");
  return value;
}

function matchesSecret(serialized: string, secret: Buffer): boolean {
  const candidate = Buffer.alloc(secret.byteLength);
  let decoded: Buffer | undefined;
  try {
    decoded = Buffer.from(serialized, "base64url");
    if (decoded.byteLength === secret.byteLength && decoded.toString("base64url") === serialized) decoded.copy(candidate);
    return timingSafeEqual(candidate, secret);
  } finally {
    decoded?.fill(0);
    candidate.fill(0);
  }
}

function assertPrivateSocket(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("accounts broker socket is not owner-private");
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  assertPrivateSocket(path);
  if (await socketIsLive(path)) throw new Error("accounts broker socket is already active");
  unlinkSync(path);
}

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (value: boolean): void => {
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

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

async function closeServer(server: Server, connections: Set<Socket>): Promise<void> {
  for (const socket of connections) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

/** Stable hash helper for tests/status agents; no consumer should expose it. */
export function accountsBrokerRootHash(root: string): string {
  return createHash("sha256").update(assertBrokerRoot(root), "utf8").digest("hex").slice(0, 24);
}

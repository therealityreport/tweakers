import { createHmac } from "node:crypto";
import { isPlainRecord, type OpaqueAccountId } from "./types";

const DEVICE_PREFIX = "accounts:remote-device:v1\0";
const MAX_PRIVATE_STRING_BYTES = 1_024;
const MAX_CURSOR_BYTES = 512;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MAX_LOADED_THREADS = 4_096;

type NativeRemoteStatus = "disabled" | "connecting" | "connected" | "errored";
type RemoteTimer = ReturnType<typeof setTimeout>;

interface NativeStatusV1 {
  status: NativeRemoteStatus;
  environmentId: string | null;
}

interface NativePairingV1 {
  pairingCode: string;
  manualPairingCode: string;
  environmentId: string;
  expiresAtMs: number;
}

interface NativeClientV1 {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  deviceModel: string | null;
}

interface NativeClientPageV1 {
  data: NativeClientV1[];
  nextCursor: string | null;
}

interface PairingStateV1 extends NativePairingV1 {
  timer: RemoteTimer | null;
}

export interface RemoteNativeRequestV1 {
  (accountId: OpaqueAccountId, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Parent-owned gate around the native remote-control lifecycle. */
export interface RemoteModeGateV1 {
  beginEnable(accountId: OpaqueAccountId): Promise<"ready" | "busy" | "unavailable">;
  commitEnabled(accountId: OpaqueAccountId): void;
  abortEnable(accountId: OpaqueAccountId): void;
  beginDisable(accountId: OpaqueAccountId): void;
  loadedThreads(accountId: OpaqueAccountId): Promise<readonly string[] | null>;
  commitDisabled(accountId: OpaqueAccountId): void;
}

export type RemotePublicStateV1 = "disabled" | "ready" | "pairing" | "mfa_required" | "unavailable";

export interface RemotePublicPairingV1 {
  code: string;
  expiresAt: string | null;
}

export interface RemotePublicDeviceV1 {
  deviceId: `device_${string}`;
  label: string;
}

/**
 * This remains on the owner-private controller/broker seam.  `accountId` is
 * the opaque account id; the adapter replaces it with the renderer account
 * handle before the result crosses a process boundary.
 */
export interface RemotePublicStatusV1 {
  accountId: OpaqueAccountId;
  enabled: boolean;
  state: RemotePublicStateV1;
  pairing: RemotePublicPairingV1 | null;
  devices: RemotePublicDeviceV1[];
}

export interface NativeRemoteControllerOptionsV1 {
  request: RemoteNativeRequestV1;
  gate: RemoteModeGateV1;
  /** Owner-private HMAC key; it is used only for public device handles. */
  secret: Buffer;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => RemoteTimer;
  clearTimer?: (timer: RemoteTimer) => void;
  /** Test seam for bounded drain polling. */
  sleep?: (delayMs: number) => Promise<void>;
  drainPollMs?: number;
  drainTimeoutMs?: number;
  maxDrainPolls?: number;
  devicePageSize?: number;
  maxDevicePages?: number;
  maxDevices?: number;
}

/**
 * Reduces the installed native remote-control protocol to the frozen Accounts
 * action shape.  Raw pairing credentials, environment ids, and client ids are
 * held only for the life of an action or short-lived in-memory pairing state.
 */
export class NativeRemoteControllerV1 {
  private readonly request: RemoteNativeRequestV1;
  private readonly gate: RemoteModeGateV1;
  private readonly secret: Buffer;
  private readonly clock: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => RemoteTimer;
  private readonly clearTimer: (timer: RemoteTimer) => void;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly drainPollMs: number;
  private readonly drainTimeoutMs: number;
  private readonly maxDrainPolls: number;
  private readonly devicePageSize: number;
  private readonly maxDevicePages: number;
  private readonly maxDevices: number;
  private readonly queues = new Map<OpaqueAccountId, Promise<void>>();
  private readonly environments = new Map<OpaqueAccountId, string>();
  private readonly pairings = new Map<OpaqueAccountId, PairingStateV1>();
  private readonly pairingGenerations = new Map<OpaqueAccountId, number>();
  private disposed = false;

  constructor(options: NativeRemoteControllerOptionsV1) {
    if (!Buffer.isBuffer(options.secret) || options.secret.byteLength < 16) throw new Error("remote controller requires an owner-private HMAC key");
    this.request = options.request;
    this.gate = options.gate;
    this.secret = options.secret;
    this.clock = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.drainPollMs = boundedInteger(options.drainPollMs, 250, 1, 10_000);
    this.drainTimeoutMs = boundedInteger(options.drainTimeoutMs, 60_000, 0, 300_000);
    this.maxDrainPolls = boundedInteger(
      options.maxDrainPolls,
      Math.min(512, Math.max(1, Math.ceil(this.drainTimeoutMs / this.drainPollMs) + 1)),
      1,
      512,
    );
    this.devicePageSize = boundedInteger(options.devicePageSize, 50, 1, 256);
    this.maxDevicePages = boundedInteger(options.maxDevicePages, 8, 1, 32);
    this.maxDevices = boundedInteger(options.maxDevices, 256, 1, 256);
    this.sleep = options.sleep ?? ((delayMs) => new Promise<void>((resolvePromise) => this.setTimer(resolvePromise, delayMs)));
  }

  status(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    return this.run(accountId, () => this.statusInternal(accountId));
  }

  enable(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    return this.run(accountId, () => this.enableInternal(accountId));
  }

  disable(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    return this.run(accountId, () => this.disableInternal(accountId));
  }

  pairingStart(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    return this.run(accountId, () => this.pairingStartInternal(accountId));
  }

  pairingStatus(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    return this.run(accountId, () => this.pairingStatusInternal(accountId));
  }

  devicesList(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    return this.run(accountId, () => this.devicesListInternal(accountId));
  }

  deviceRevoke(accountId: OpaqueAccountId, publicDeviceId: string): Promise<RemotePublicStatusV1> {
    return this.run(accountId, () => this.deviceRevokeInternal(accountId, publicDeviceId));
  }

  /** The host invokes this when the pairing panel closes or changes account. */
  closePairing(accountId: OpaqueAccountId): void {
    this.invalidatePairing(accountId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const accountId of [...this.pairings.keys()]) this.invalidatePairing(accountId);
    this.environments.clear();
  }

  private run(accountId: OpaqueAccountId, action: () => Promise<RemotePublicStatusV1>): Promise<RemotePublicStatusV1> {
    const previous = this.queues.get(accountId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      if (this.disposed) return this.unavailable(accountId);
      return action();
    });
    const tail = task.then(() => undefined, () => undefined);
    this.queues.set(accountId, tail);
    void tail.then(() => {
      if (this.queues.get(accountId) === tail) this.queues.delete(accountId);
    });
    return task.catch(() => this.unavailable(accountId));
  }

  private async statusInternal(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    const native = await this.readNativeStatus(accountId);
    return native ? this.publicFromNative(accountId, native) : this.unavailable(accountId);
  }

  private async enableInternal(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    let readiness: "ready" | "busy" | "unavailable";
    try {
      readiness = await this.gate.beginEnable(accountId);
    } catch {
      return this.unavailable(accountId);
    }
    if (readiness !== "ready" || this.disposed) return this.unavailable(accountId);

    this.invalidatePairing(accountId);
    let response: unknown;
    try {
      response = await this.request(accountId, "remoteControl/enable", { ephemeral: true });
    } catch (error) {
      if (isExplicitNativeFailure(error)) {
        this.abortEnable(accountId);
        return this.unavailable(accountId);
      }
      await this.settleAmbiguousEnable(accountId);
      return this.unavailable(accountId);
    }

    const native = parseNativeStatus(response);
    if (native?.status === "connecting" || native?.status === "connected") {
      this.recordEnvironment(accountId, native.environmentId);
      if (this.disposed) {
        await this.settleAmbiguousEnable(accountId);
        return this.unavailable(accountId);
      }
      try {
        this.gate.commitEnabled(accountId);
      } catch {
        await this.settleAmbiguousEnable(accountId);
        return this.unavailable(accountId);
      }
      return this.publicFromNative(accountId, native);
    }

    // An explicit disabled response proves the native call did not enable
    // remote control.  Every other result is ambiguous and remains gated.
    if (native?.status === "disabled") {
      this.recordEnvironment(accountId, null);
      this.abortEnable(accountId);
      return this.publicFromNative(accountId, native);
    }
    await this.settleAmbiguousEnable(accountId);
    return this.unavailable(accountId);
  }

  private async disableInternal(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    this.invalidatePairing(accountId);
    return (await this.disableAndDrain(accountId))
      ? this.disabled(accountId)
      : this.unavailable(accountId);
  }

  private async pairingStartInternal(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    const generation = this.invalidatePairing(accountId);
    let response: unknown;
    try {
      response = await this.request(accountId, "remoteControl/pairing/start", { manualCode: true });
    } catch {
      return this.unavailable(accountId);
    }
    const pairing = parseNativePairing(response);
    if (!pairing || pairing.expiresAtMs <= this.now() || this.disposed || this.pairingGeneration(accountId) !== generation) return this.unavailable(accountId);
    this.recordEnvironment(accountId, pairing.environmentId);
    if (!this.rememberPairing(accountId, pairing)) return this.unavailable(accountId);
    return {
      accountId,
      enabled: true,
      state: "pairing",
      pairing: { code: pairing.manualPairingCode, expiresAt: new Date(pairing.expiresAtMs).toISOString() },
      devices: [],
    };
  }

  private async pairingStatusInternal(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    const pairing = this.currentPairing(accountId);
    if (!pairing) return this.statusInternal(accountId);
    let response: unknown;
    try {
      // The native protocol accepts exactly one pairing identifier.
      response = await this.request(accountId, "remoteControl/pairing/status", { pairingCode: pairing.pairingCode });
    } catch {
      return this.unavailable(accountId);
    }
    const claimed = parsePairingClaim(response);
    if (claimed === null) return this.unavailable(accountId);
    if (!claimed) {
      const active = this.currentPairing(accountId);
      if (!active) return this.statusInternal(accountId);
      return {
        accountId,
        enabled: true,
        state: "pairing",
        pairing: { code: active.manualPairingCode, expiresAt: new Date(active.expiresAtMs).toISOString() },
        devices: [],
      };
    }
    this.invalidatePairing(accountId);
    return this.statusInternal(accountId);
  }

  private async devicesListInternal(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1> {
    const native = await this.readNativeStatus(accountId);
    if (!native) return this.unavailable(accountId);
    const base = this.publicFromNative(accountId, native);
    if (base.state === "disabled" || base.state === "unavailable") return base;
    const environmentId = this.environments.get(accountId);
    if (!environmentId) return this.unavailable(accountId);
    const listed = await this.listDevices(accountId, environmentId);
    return listed === null ? this.unavailable(accountId) : { ...base, devices: listed };
  }

  private async deviceRevokeInternal(accountId: OpaqueAccountId, publicDeviceId: string): Promise<RemotePublicStatusV1> {
    if (!/^device_[A-Za-z0-9_-]{43}$/.test(publicDeviceId)) return this.unavailable(accountId);
    const native = await this.readNativeStatus(accountId);
    if (!native) return this.unavailable(accountId);
    const base = this.publicFromNative(accountId, native);
    if (base.state === "disabled" || base.state === "unavailable") return base;
    const environmentId = this.environments.get(accountId);
    if (!environmentId) return this.unavailable(accountId);
    const listed = await this.listDevicesWithPrivateIds(accountId, environmentId);
    if (listed === null) return this.unavailable(accountId);
    const target = listed.find((item) => item.publicDevice.deviceId === publicDeviceId);
    if (!target) return { ...base, devices: listed.map((item) => item.publicDevice) };
    try {
      const response = await this.request(accountId, "remoteControl/client/revoke", {
        environmentId,
        clientId: target.clientId,
      });
      if (!isEmptyRecord(response)) return this.unavailable(accountId);
    } catch {
      return this.unavailable(accountId);
    }
    // Re-list from the native source.  A raw-id lookup is never cached.
    const refreshed = await this.listDevices(accountId, environmentId);
    return refreshed === null ? this.unavailable(accountId) : { ...base, devices: refreshed };
  }

  private async readNativeStatus(accountId: OpaqueAccountId): Promise<NativeStatusV1 | null> {
    try {
      const native = parseNativeStatus(await this.request(accountId, "remoteControl/status/read"));
      if (!native) return null;
      this.recordEnvironment(accountId, native.environmentId);
      return native;
    } catch {
      return null;
    }
  }

  private async disableAndDrain(accountId: OpaqueAccountId): Promise<boolean> {
    try {
      this.gate.beginDisable(accountId);
    } catch {
      return false;
    }
    let response: unknown;
    try {
      response = await this.request(accountId, "remoteControl/disable", { ephemeral: true });
    } catch {
      return false;
    }
    const native = parseNativeStatus(response);
    if (native?.status !== "disabled") return false;
    this.recordEnvironment(accountId, null);
    return this.drainDisabled(accountId);
  }

  private async settleAmbiguousEnable(accountId: OpaqueAccountId): Promise<void> {
    this.invalidatePairing(accountId);
    await this.disableAndDrain(accountId);
  }

  private async drainDisabled(accountId: OpaqueAccountId): Promise<boolean> {
    const deadline = this.now() + this.drainTimeoutMs;
    for (let attempt = 0; attempt < this.maxDrainPolls && !this.disposed; attempt += 1) {
      let threads: readonly string[] | null;
      try {
        threads = await this.gate.loadedThreads(accountId);
      } catch {
        return false;
      }
      if (!validLoadedThreads(threads)) return false;
      if (threads.length === 0) {
        try {
          this.gate.commitDisabled(accountId);
          return true;
        } catch {
          return false;
        }
      }
      const remaining = deadline - this.now();
      if (remaining <= 0 || attempt + 1 >= this.maxDrainPolls) return false;
      try {
        await this.sleep(Math.min(this.drainPollMs, remaining));
      } catch {
        return false;
      }
    }
    return false;
  }

  private async listDevices(accountId: OpaqueAccountId, environmentId: string): Promise<RemotePublicDeviceV1[] | null> {
    const entries = await this.listDevicesWithPrivateIds(accountId, environmentId);
    return entries?.map((item) => item.publicDevice) ?? null;
  }

  private async listDevicesWithPrivateIds(accountId: OpaqueAccountId, environmentId: string): Promise<Array<{ clientId: string; publicDevice: RemotePublicDeviceV1 }> | null> {
    const devices: Array<{ clientId: string; publicDevice: RemotePublicDeviceV1 }> = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < this.maxDevicePages; pageNumber += 1) {
      const params: Record<string, unknown> = { environmentId, limit: this.devicePageSize, order: "desc" };
      if (cursor !== null) params.cursor = cursor;
      let page: NativeClientPageV1 | null;
      try {
        page = parseNativeClientPage(await this.request(accountId, "remoteControl/client/list", params), this.devicePageSize);
      } catch {
        return null;
      }
      if (!page || devices.length + page.data.length > this.maxDevices) return null;
      for (const client of page.data) {
        devices.push({
          clientId: client.clientId,
          publicDevice: {
            deviceId: this.publicDeviceId(accountId, environmentId, client.clientId),
            label: deviceLabel(client),
          },
        });
      }
      if (page.nextCursor === null) return devices;
      if (seenCursors.has(page.nextCursor)) return null;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return null;
  }

  private publicFromNative(accountId: OpaqueAccountId, native: NativeStatusV1): RemotePublicStatusV1 {
    if (native.status === "disabled") {
      this.recordEnvironment(accountId, null);
      this.invalidatePairing(accountId);
      return this.disabled(accountId);
    }
    if (native.status === "errored") {
      this.invalidatePairing(accountId);
      return this.unavailable(accountId);
    }
    const state: RemotePublicStateV1 = native.status === "connected" ? "ready" : "pairing";
    const pairing = this.currentPairing(accountId);
    return {
      accountId,
      enabled: true,
      state,
      pairing: pairing ? { code: pairing.manualPairingCode, expiresAt: new Date(pairing.expiresAtMs).toISOString() } : null,
      devices: [],
    };
  }

  private disabled(accountId: OpaqueAccountId): RemotePublicStatusV1 {
    return { accountId, enabled: false, state: "disabled", pairing: null, devices: [] };
  }

  private unavailable(accountId: OpaqueAccountId): RemotePublicStatusV1 {
    return { accountId, enabled: false, state: "unavailable", pairing: null, devices: [] };
  }

  private publicDeviceId(accountId: OpaqueAccountId, environmentId: string, clientId: string): `device_${string}` {
    return `device_${createHmac("sha256", this.secret)
      .update(`${DEVICE_PREFIX}${accountId}\0${environmentId}\0${clientId}`, "utf8")
      .digest("base64url")}`;
  }

  private recordEnvironment(accountId: OpaqueAccountId, environmentId: string | null): void {
    if (environmentId === null) this.environments.delete(accountId);
    else this.environments.set(accountId, environmentId);
  }

  private pairingGeneration(accountId: OpaqueAccountId): number {
    return this.pairingGenerations.get(accountId) ?? 0;
  }

  private invalidatePairing(accountId: OpaqueAccountId): number {
    const next = this.pairingGeneration(accountId) + 1;
    this.pairingGenerations.set(accountId, next);
    const pairing = this.pairings.get(accountId);
    if (pairing && pairing.timer !== null) {
      try { this.clearTimer(pairing.timer); } catch { /* clearing a local timer cannot widen access */ }
    }
    this.pairings.delete(accountId);
    return next;
  }

  private currentPairing(accountId: OpaqueAccountId): PairingStateV1 | null {
    const pairing = this.pairings.get(accountId);
    if (!pairing) return null;
    if (pairing.expiresAtMs <= this.now()) {
      this.invalidatePairing(accountId);
      return null;
    }
    return pairing;
  }

  private rememberPairing(accountId: OpaqueAccountId, pairing: NativePairingV1): boolean {
    const state: PairingStateV1 = { ...pairing, timer: null };
    this.pairings.set(accountId, state);
    try {
      this.schedulePairingExpiry(accountId, state);
      return true;
    } catch {
      this.invalidatePairing(accountId);
      return false;
    }
  }

  private schedulePairingExpiry(accountId: OpaqueAccountId, pairing: PairingStateV1): void {
    const schedule = (): void => {
      if (this.disposed || this.pairings.get(accountId) !== pairing) return;
      const remaining = pairing.expiresAtMs - this.now();
      if (remaining <= 0) {
        this.invalidatePairing(accountId);
        return;
      }
      pairing.timer = this.setTimer(() => {
        try {
          if (this.pairings.get(accountId) !== pairing) return;
          if (pairing.expiresAtMs <= this.now()) this.invalidatePairing(accountId);
          else schedule();
        } catch {
          this.invalidatePairing(accountId);
        }
      }, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    schedule();
  }

  private abortEnable(accountId: OpaqueAccountId): void {
    try { this.gate.abortEnable(accountId); } catch { /* a failed rollback remains unavailable to callers */ }
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isFinite(now) || now < 0) throw new Error("invalid remote controller clock");
    return now;
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) throw new Error("invalid remote controller bound");
  return resolved;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function privateString(value: unknown, maximumBytes = MAX_PRIVATE_STRING_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximumBytes && !/[\u0000-\u001f\u007f]/.test(value);
}

function optionalPrivateString(value: unknown): value is string | null {
  return value === null || privateString(value);
}

function nativeUnixSeconds(value: unknown): number | null {
  const seconds = typeof value === "bigint"
    ? (value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : NaN)
    : value;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) return null;
  const milliseconds = seconds * 1_000;
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
}

function parseNativeStatus(value: unknown): NativeStatusV1 | null {
  if (!isPlainRecord(value) || !exactKeys(value, ["environmentId", "installationId", "serverName", "status"])) return null;
  if (!privateString(value.serverName) || !privateString(value.installationId) || !optionalPrivateString(value.environmentId)) return null;
  if (value.status !== "disabled" && value.status !== "connecting" && value.status !== "connected" && value.status !== "errored") return null;
  return { status: value.status, environmentId: value.environmentId };
}

function parseNativePairing(value: unknown): NativePairingV1 | null {
  if (!isPlainRecord(value) || !exactKeys(value, ["environmentId", "expiresAt", "manualPairingCode", "pairingCode"])) return null;
  const expiresAtMs = nativeUnixSeconds(value.expiresAt);
  if (!privateString(value.pairingCode) || !privateString(value.environmentId) || !safeManualPairingCode(value.manualPairingCode) || expiresAtMs === null) return null;
  return { pairingCode: value.pairingCode, manualPairingCode: value.manualPairingCode, environmentId: value.environmentId, expiresAtMs };
}

function parsePairingClaim(value: unknown): boolean | null {
  return isPlainRecord(value) && exactKeys(value, ["claimed"]) && typeof value.claimed === "boolean" ? value.claimed : null;
}

function parseNativeClientPage(value: unknown, pageSize: number): NativeClientPageV1 | null {
  if (!isPlainRecord(value) || !exactKeys(value, ["data", "nextCursor"]) || !Array.isArray(value.data) || value.data.length > pageSize
    || !(value.nextCursor === null || privateString(value.nextCursor, MAX_CURSOR_BYTES))) return null;
  const data: NativeClientV1[] = [];
  for (const entry of value.data) {
    const client = parseNativeClient(entry);
    if (!client) return null;
    data.push(client);
  }
  return { data, nextCursor: value.nextCursor };
}

function parseNativeClient(value: unknown): NativeClientV1 | null {
  const keys = ["appVersion", "clientId", "deviceModel", "deviceType", "displayName", "lastSeenAt", "osVersion", "platform"];
  if (!isPlainRecord(value) || !exactKeys(value, keys) || !privateString(value.clientId)
    || !optionalPrivateString(value.displayName) || !optionalPrivateString(value.deviceType)
    || !optionalPrivateString(value.platform) || !optionalPrivateString(value.osVersion)
    || !optionalPrivateString(value.deviceModel) || !optionalPrivateString(value.appVersion)
    || !(value.lastSeenAt === null || typeof value.lastSeenAt === "number" && Number.isSafeInteger(value.lastSeenAt)
      || typeof value.lastSeenAt === "bigint" && value.lastSeenAt <= BigInt(Number.MAX_SAFE_INTEGER))) return null;
  return {
    clientId: value.clientId,
    displayName: value.displayName,
    deviceType: value.deviceType,
    platform: value.platform,
    deviceModel: value.deviceModel,
  };
}

function validLoadedThreads(value: readonly string[] | null): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_LOADED_THREADS && value.every((thread) => privateString(thread));
}

function isExplicitNativeFailure(value: unknown): boolean {
  if (!isPlainRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const keys = Object.keys(value);
  return keys.includes("code") && keys.includes("message") && keys.every((key) => key === "code" || key === "message" || key === "data")
    && Number.isInteger(value.code) && typeof value.message === "string";
}

function isEmptyRecord(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

/** Keep direct action output compatible with the broker's generic redactor. */
function safeManualPairingCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{4,64}$/.test(value) && !/^sk-[A-Za-z0-9]/i.test(value);
}

function deviceLabel(client: NativeClientV1): string {
  for (const candidate of [client.displayName, client.deviceModel, client.platform, client.deviceType]) {
    const label = safeLabel(candidate);
    if (label) return label;
  }
  return "Paired device";
}

function safeLabel(value: string | null): string | null {
  if (value === null) return null;
  const label = value.replace(/\s+/g, " ").trim();
  if (label.length === 0 || Buffer.byteLength(label, "utf8") > 128 || !/^[\x20-\x7e]+$/.test(label)) return null;
  if (/(?:bearer\s+|sk-[A-Za-z0-9]|\/auth\.json|BEGIN [A-Z ]+PRIVATE KEY|secret|token|credential|password|api.?key|@)/i.test(label)) return null;
  return label;
}

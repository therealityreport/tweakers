"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeRemoteControllerV1 = void 0;
const node_crypto_1 = require("node:crypto");
const types_1 = require("./types");
const DEVICE_PREFIX = "accounts:remote-device:v1\0";
const MAX_PRIVATE_STRING_BYTES = 1_024;
const MAX_CURSOR_BYTES = 512;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MAX_LOADED_THREADS = 4_096;
/**
 * Reduces the installed native remote-control protocol to the frozen Accounts
 * action shape.  Raw pairing credentials, environment ids, and client ids are
 * held only for the life of an action or short-lived in-memory pairing state.
 */
class NativeRemoteControllerV1 {
    request;
    gate;
    secret;
    clock;
    setTimer;
    clearTimer;
    sleep;
    drainPollMs;
    drainTimeoutMs;
    maxDrainPolls;
    devicePageSize;
    maxDevicePages;
    maxDevices;
    queues = new Map();
    environments = new Map();
    pairings = new Map();
    pairingGenerations = new Map();
    disposed = false;
    constructor(options) {
        if (!Buffer.isBuffer(options.secret) || options.secret.byteLength < 16)
            throw new Error("remote controller requires an owner-private HMAC key");
        this.request = options.request;
        this.gate = options.gate;
        this.secret = options.secret;
        this.clock = options.now ?? Date.now;
        this.setTimer = options.setTimer ?? setTimeout;
        this.clearTimer = options.clearTimer ?? clearTimeout;
        this.drainPollMs = boundedInteger(options.drainPollMs, 250, 1, 10_000);
        this.drainTimeoutMs = boundedInteger(options.drainTimeoutMs, 60_000, 0, 300_000);
        this.maxDrainPolls = boundedInteger(options.maxDrainPolls, Math.min(512, Math.max(1, Math.ceil(this.drainTimeoutMs / this.drainPollMs) + 1)), 1, 512);
        this.devicePageSize = boundedInteger(options.devicePageSize, 50, 1, 256);
        this.maxDevicePages = boundedInteger(options.maxDevicePages, 8, 1, 32);
        this.maxDevices = boundedInteger(options.maxDevices, 256, 1, 256);
        this.sleep = options.sleep ?? ((delayMs) => new Promise((resolvePromise) => this.setTimer(resolvePromise, delayMs)));
    }
    status(accountId) {
        return this.run(accountId, () => this.statusInternal(accountId));
    }
    enable(accountId) {
        return this.run(accountId, () => this.enableInternal(accountId));
    }
    disable(accountId) {
        return this.run(accountId, () => this.disableInternal(accountId));
    }
    pairingStart(accountId) {
        return this.run(accountId, () => this.pairingStartInternal(accountId));
    }
    pairingStatus(accountId) {
        return this.run(accountId, () => this.pairingStatusInternal(accountId));
    }
    devicesList(accountId) {
        return this.run(accountId, () => this.devicesListInternal(accountId));
    }
    deviceRevoke(accountId, publicDeviceId) {
        return this.run(accountId, () => this.deviceRevokeInternal(accountId, publicDeviceId));
    }
    /** The host invokes this when the pairing panel closes or changes account. */
    closePairing(accountId) {
        this.invalidatePairing(accountId);
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const accountId of [...this.pairings.keys()])
            this.invalidatePairing(accountId);
        this.environments.clear();
    }
    run(accountId, action) {
        const previous = this.queues.get(accountId) ?? Promise.resolve();
        const task = previous.catch(() => undefined).then(async () => {
            if (this.disposed)
                return this.unavailable(accountId);
            return action();
        });
        const tail = task.then(() => undefined, () => undefined);
        this.queues.set(accountId, tail);
        void tail.then(() => {
            if (this.queues.get(accountId) === tail)
                this.queues.delete(accountId);
        });
        return task.catch(() => this.unavailable(accountId));
    }
    async statusInternal(accountId) {
        const native = await this.readNativeStatus(accountId);
        return native ? this.publicFromNative(accountId, native) : this.unavailable(accountId);
    }
    async enableInternal(accountId) {
        let readiness;
        try {
            readiness = await this.gate.beginEnable(accountId);
        }
        catch {
            return this.unavailable(accountId);
        }
        if (readiness !== "ready" || this.disposed)
            return this.unavailable(accountId);
        this.invalidatePairing(accountId);
        let response;
        try {
            response = await this.request(accountId, "remoteControl/enable", { ephemeral: true });
        }
        catch (error) {
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
            }
            catch {
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
    async disableInternal(accountId) {
        this.invalidatePairing(accountId);
        return (await this.disableAndDrain(accountId))
            ? this.disabled(accountId)
            : this.unavailable(accountId);
    }
    async pairingStartInternal(accountId) {
        const generation = this.invalidatePairing(accountId);
        let response;
        try {
            response = await this.request(accountId, "remoteControl/pairing/start", { manualCode: true });
        }
        catch {
            return this.unavailable(accountId);
        }
        const pairing = parseNativePairing(response);
        if (!pairing || pairing.expiresAtMs <= this.now() || this.disposed || this.pairingGeneration(accountId) !== generation)
            return this.unavailable(accountId);
        this.recordEnvironment(accountId, pairing.environmentId);
        if (!this.rememberPairing(accountId, pairing))
            return this.unavailable(accountId);
        return {
            accountId,
            enabled: true,
            state: "pairing",
            pairing: { code: pairing.manualPairingCode, expiresAt: new Date(pairing.expiresAtMs).toISOString() },
            devices: [],
        };
    }
    async pairingStatusInternal(accountId) {
        const pairing = this.currentPairing(accountId);
        if (!pairing)
            return this.statusInternal(accountId);
        let response;
        try {
            // The native protocol accepts exactly one pairing identifier.
            response = await this.request(accountId, "remoteControl/pairing/status", { pairingCode: pairing.pairingCode });
        }
        catch {
            return this.unavailable(accountId);
        }
        const claimed = parsePairingClaim(response);
        if (claimed === null)
            return this.unavailable(accountId);
        if (!claimed) {
            const active = this.currentPairing(accountId);
            if (!active)
                return this.statusInternal(accountId);
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
    async devicesListInternal(accountId) {
        const native = await this.readNativeStatus(accountId);
        if (!native)
            return this.unavailable(accountId);
        const base = this.publicFromNative(accountId, native);
        if (base.state === "disabled" || base.state === "unavailable")
            return base;
        const environmentId = this.environments.get(accountId);
        if (!environmentId)
            return this.unavailable(accountId);
        const listed = await this.listDevices(accountId, environmentId);
        return listed === null ? this.unavailable(accountId) : { ...base, devices: listed };
    }
    async deviceRevokeInternal(accountId, publicDeviceId) {
        if (!/^device_[A-Za-z0-9_-]{43}$/.test(publicDeviceId))
            return this.unavailable(accountId);
        const native = await this.readNativeStatus(accountId);
        if (!native)
            return this.unavailable(accountId);
        const base = this.publicFromNative(accountId, native);
        if (base.state === "disabled" || base.state === "unavailable")
            return base;
        const environmentId = this.environments.get(accountId);
        if (!environmentId)
            return this.unavailable(accountId);
        const listed = await this.listDevicesWithPrivateIds(accountId, environmentId);
        if (listed === null)
            return this.unavailable(accountId);
        const target = listed.find((item) => item.publicDevice.deviceId === publicDeviceId);
        if (!target)
            return { ...base, devices: listed.map((item) => item.publicDevice) };
        try {
            const response = await this.request(accountId, "remoteControl/client/revoke", {
                environmentId,
                clientId: target.clientId,
            });
            if (!isEmptyRecord(response))
                return this.unavailable(accountId);
        }
        catch {
            return this.unavailable(accountId);
        }
        // Re-list from the native source.  A raw-id lookup is never cached.
        const refreshed = await this.listDevices(accountId, environmentId);
        return refreshed === null ? this.unavailable(accountId) : { ...base, devices: refreshed };
    }
    async readNativeStatus(accountId) {
        try {
            const native = parseNativeStatus(await this.request(accountId, "remoteControl/status/read"));
            if (!native)
                return null;
            this.recordEnvironment(accountId, native.environmentId);
            return native;
        }
        catch {
            return null;
        }
    }
    async disableAndDrain(accountId) {
        try {
            this.gate.beginDisable(accountId);
        }
        catch {
            return false;
        }
        let response;
        try {
            response = await this.request(accountId, "remoteControl/disable", { ephemeral: true });
        }
        catch {
            return false;
        }
        const native = parseNativeStatus(response);
        if (native?.status !== "disabled")
            return false;
        this.recordEnvironment(accountId, null);
        return this.drainDisabled(accountId);
    }
    async settleAmbiguousEnable(accountId) {
        this.invalidatePairing(accountId);
        await this.disableAndDrain(accountId);
    }
    async drainDisabled(accountId) {
        const deadline = this.now() + this.drainTimeoutMs;
        for (let attempt = 0; attempt < this.maxDrainPolls && !this.disposed; attempt += 1) {
            let threads;
            try {
                threads = await this.gate.loadedThreads(accountId);
            }
            catch {
                return false;
            }
            if (!validLoadedThreads(threads))
                return false;
            if (threads.length === 0) {
                try {
                    this.gate.commitDisabled(accountId);
                    return true;
                }
                catch {
                    return false;
                }
            }
            const remaining = deadline - this.now();
            if (remaining <= 0 || attempt + 1 >= this.maxDrainPolls)
                return false;
            try {
                await this.sleep(Math.min(this.drainPollMs, remaining));
            }
            catch {
                return false;
            }
        }
        return false;
    }
    async listDevices(accountId, environmentId) {
        const entries = await this.listDevicesWithPrivateIds(accountId, environmentId);
        return entries?.map((item) => item.publicDevice) ?? null;
    }
    async listDevicesWithPrivateIds(accountId, environmentId) {
        const devices = [];
        const seenCursors = new Set();
        let cursor = null;
        for (let pageNumber = 0; pageNumber < this.maxDevicePages; pageNumber += 1) {
            const params = { environmentId, limit: this.devicePageSize, order: "desc" };
            if (cursor !== null)
                params.cursor = cursor;
            let page;
            try {
                page = parseNativeClientPage(await this.request(accountId, "remoteControl/client/list", params), this.devicePageSize);
            }
            catch {
                return null;
            }
            if (!page || devices.length + page.data.length > this.maxDevices)
                return null;
            for (const client of page.data) {
                devices.push({
                    clientId: client.clientId,
                    publicDevice: {
                        deviceId: this.publicDeviceId(accountId, environmentId, client.clientId),
                        label: deviceLabel(client),
                    },
                });
            }
            if (page.nextCursor === null)
                return devices;
            if (seenCursors.has(page.nextCursor))
                return null;
            seenCursors.add(page.nextCursor);
            cursor = page.nextCursor;
        }
        return null;
    }
    publicFromNative(accountId, native) {
        if (native.status === "disabled") {
            this.recordEnvironment(accountId, null);
            this.invalidatePairing(accountId);
            return this.disabled(accountId);
        }
        if (native.status === "errored") {
            this.invalidatePairing(accountId);
            return this.unavailable(accountId);
        }
        const state = native.status === "connected" ? "ready" : "pairing";
        const pairing = this.currentPairing(accountId);
        return {
            accountId,
            enabled: true,
            state,
            pairing: pairing ? { code: pairing.manualPairingCode, expiresAt: new Date(pairing.expiresAtMs).toISOString() } : null,
            devices: [],
        };
    }
    disabled(accountId) {
        return { accountId, enabled: false, state: "disabled", pairing: null, devices: [] };
    }
    unavailable(accountId) {
        return { accountId, enabled: false, state: "unavailable", pairing: null, devices: [] };
    }
    publicDeviceId(accountId, environmentId, clientId) {
        return `device_${(0, node_crypto_1.createHmac)("sha256", this.secret)
            .update(`${DEVICE_PREFIX}${accountId}\0${environmentId}\0${clientId}`, "utf8")
            .digest("base64url")}`;
    }
    recordEnvironment(accountId, environmentId) {
        if (environmentId === null)
            this.environments.delete(accountId);
        else
            this.environments.set(accountId, environmentId);
    }
    pairingGeneration(accountId) {
        return this.pairingGenerations.get(accountId) ?? 0;
    }
    invalidatePairing(accountId) {
        const next = this.pairingGeneration(accountId) + 1;
        this.pairingGenerations.set(accountId, next);
        const pairing = this.pairings.get(accountId);
        if (pairing && pairing.timer !== null) {
            try {
                this.clearTimer(pairing.timer);
            }
            catch { /* clearing a local timer cannot widen access */ }
        }
        this.pairings.delete(accountId);
        return next;
    }
    currentPairing(accountId) {
        const pairing = this.pairings.get(accountId);
        if (!pairing)
            return null;
        if (pairing.expiresAtMs <= this.now()) {
            this.invalidatePairing(accountId);
            return null;
        }
        return pairing;
    }
    rememberPairing(accountId, pairing) {
        const state = { ...pairing, timer: null };
        this.pairings.set(accountId, state);
        try {
            this.schedulePairingExpiry(accountId, state);
            return true;
        }
        catch {
            this.invalidatePairing(accountId);
            return false;
        }
    }
    schedulePairingExpiry(accountId, pairing) {
        const schedule = () => {
            if (this.disposed || this.pairings.get(accountId) !== pairing)
                return;
            const remaining = pairing.expiresAtMs - this.now();
            if (remaining <= 0) {
                this.invalidatePairing(accountId);
                return;
            }
            pairing.timer = this.setTimer(() => {
                try {
                    if (this.pairings.get(accountId) !== pairing)
                        return;
                    if (pairing.expiresAtMs <= this.now())
                        this.invalidatePairing(accountId);
                    else
                        schedule();
                }
                catch {
                    this.invalidatePairing(accountId);
                }
            }, Math.min(remaining, MAX_TIMER_DELAY_MS));
        };
        schedule();
    }
    abortEnable(accountId) {
        try {
            this.gate.abortEnable(accountId);
        }
        catch { /* a failed rollback remains unavailable to callers */ }
    }
    now() {
        const now = this.clock();
        if (!Number.isFinite(now) || now < 0)
            throw new Error("invalid remote controller clock");
        return now;
    }
}
exports.NativeRemoteControllerV1 = NativeRemoteControllerV1;
function boundedInteger(value, fallback, minimum, maximum) {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum)
        throw new Error("invalid remote controller bound");
    return resolved;
}
function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function privateString(value, maximumBytes = MAX_PRIVATE_STRING_BYTES) {
    return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximumBytes && !/[\u0000-\u001f\u007f]/.test(value);
}
function optionalPrivateString(value) {
    return value === null || privateString(value);
}
function nativeUnixSeconds(value) {
    const seconds = typeof value === "bigint"
        ? (value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : NaN)
        : value;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000))
        return null;
    const milliseconds = seconds * 1_000;
    return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
}
function parseNativeStatus(value) {
    if (!(0, types_1.isPlainRecord)(value) || !exactKeys(value, ["environmentId", "installationId", "serverName", "status"]))
        return null;
    if (!privateString(value.serverName) || !privateString(value.installationId) || !optionalPrivateString(value.environmentId))
        return null;
    if (value.status !== "disabled" && value.status !== "connecting" && value.status !== "connected" && value.status !== "errored")
        return null;
    return { status: value.status, environmentId: value.environmentId };
}
function parseNativePairing(value) {
    if (!(0, types_1.isPlainRecord)(value) || !exactKeys(value, ["environmentId", "expiresAt", "manualPairingCode", "pairingCode"]))
        return null;
    const expiresAtMs = nativeUnixSeconds(value.expiresAt);
    if (!privateString(value.pairingCode) || !privateString(value.environmentId) || !safeManualPairingCode(value.manualPairingCode) || expiresAtMs === null)
        return null;
    return { pairingCode: value.pairingCode, manualPairingCode: value.manualPairingCode, environmentId: value.environmentId, expiresAtMs };
}
function parsePairingClaim(value) {
    return (0, types_1.isPlainRecord)(value) && exactKeys(value, ["claimed"]) && typeof value.claimed === "boolean" ? value.claimed : null;
}
function parseNativeClientPage(value, pageSize) {
    if (!(0, types_1.isPlainRecord)(value) || !exactKeys(value, ["data", "nextCursor"]) || !Array.isArray(value.data) || value.data.length > pageSize
        || !(value.nextCursor === null || privateString(value.nextCursor, MAX_CURSOR_BYTES)))
        return null;
    const data = [];
    for (const entry of value.data) {
        const client = parseNativeClient(entry);
        if (!client)
            return null;
        data.push(client);
    }
    return { data, nextCursor: value.nextCursor };
}
function parseNativeClient(value) {
    const keys = ["appVersion", "clientId", "deviceModel", "deviceType", "displayName", "lastSeenAt", "osVersion", "platform"];
    if (!(0, types_1.isPlainRecord)(value) || !exactKeys(value, keys) || !privateString(value.clientId)
        || !optionalPrivateString(value.displayName) || !optionalPrivateString(value.deviceType)
        || !optionalPrivateString(value.platform) || !optionalPrivateString(value.osVersion)
        || !optionalPrivateString(value.deviceModel) || !optionalPrivateString(value.appVersion)
        || !(value.lastSeenAt === null || typeof value.lastSeenAt === "number" && Number.isSafeInteger(value.lastSeenAt)
            || typeof value.lastSeenAt === "bigint" && value.lastSeenAt <= BigInt(Number.MAX_SAFE_INTEGER)))
        return null;
    return {
        clientId: value.clientId,
        displayName: value.displayName,
        deviceType: value.deviceType,
        platform: value.platform,
        deviceModel: value.deviceModel,
    };
}
function validLoadedThreads(value) {
    return Array.isArray(value) && value.length <= MAX_LOADED_THREADS && value.every((thread) => privateString(thread));
}
function isExplicitNativeFailure(value) {
    if (!(0, types_1.isPlainRecord)(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
        return false;
    const keys = Object.keys(value);
    return keys.includes("code") && keys.includes("message") && keys.every((key) => key === "code" || key === "message" || key === "data")
        && Number.isInteger(value.code) && typeof value.message === "string";
}
function isEmptyRecord(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).length === 0;
}
/** Keep direct action output compatible with the broker's generic redactor. */
function safeManualPairingCode(value) {
    return typeof value === "string" && /^[A-Za-z0-9-]{4,64}$/.test(value) && !/^sk-[A-Za-z0-9]/i.test(value);
}
function deviceLabel(client) {
    for (const candidate of [client.displayName, client.deviceModel, client.platform, client.deviceType]) {
        const label = safeLabel(candidate);
        if (label)
            return label;
    }
    return "Paired device";
}
function safeLabel(value) {
    if (value === null)
        return null;
    const label = value.replace(/\s+/g, " ").trim();
    if (label.length === 0 || Buffer.byteLength(label, "utf8") > 128 || !/^[\x20-\x7e]+$/.test(label))
        return null;
    if (/(?:bearer\s+|sk-[A-Za-z0-9]|\/auth\.json|BEGIN [A-Z ]+PRIVATE KEY|secret|token|credential|password|api.?key|@)/i.test(label))
        return null;
    return label;
}
//# sourceMappingURL=remote-controller.js.map
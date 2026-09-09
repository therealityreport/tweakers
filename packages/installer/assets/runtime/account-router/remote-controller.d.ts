import { type OpaqueAccountId } from "./types";
type RemoteTimer = ReturnType<typeof setTimeout>;
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
export declare class NativeRemoteControllerV1 {
    private readonly request;
    private readonly gate;
    private readonly secret;
    private readonly clock;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly sleep;
    private readonly drainPollMs;
    private readonly drainTimeoutMs;
    private readonly maxDrainPolls;
    private readonly devicePageSize;
    private readonly maxDevicePages;
    private readonly maxDevices;
    private readonly queues;
    private readonly environments;
    private readonly pairings;
    private readonly pairingGenerations;
    private disposed;
    constructor(options: NativeRemoteControllerOptionsV1);
    status(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1>;
    enable(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1>;
    disable(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1>;
    pairingStart(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1>;
    pairingStatus(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1>;
    devicesList(accountId: OpaqueAccountId): Promise<RemotePublicStatusV1>;
    deviceRevoke(accountId: OpaqueAccountId, publicDeviceId: string): Promise<RemotePublicStatusV1>;
    /** The host invokes this when the pairing panel closes or changes account. */
    closePairing(accountId: OpaqueAccountId): void;
    dispose(): void;
    private run;
    private statusInternal;
    private enableInternal;
    private disableInternal;
    private pairingStartInternal;
    private pairingStatusInternal;
    private devicesListInternal;
    private deviceRevokeInternal;
    private readNativeStatus;
    private disableAndDrain;
    private settleAmbiguousEnable;
    private drainDisabled;
    private listDevices;
    private listDevicesWithPrivateIds;
    private publicFromNative;
    private disabled;
    private unavailable;
    private publicDeviceId;
    private recordEnvironment;
    private pairingGeneration;
    private invalidatePairing;
    private currentPairing;
    private rememberPairing;
    private schedulePairingExpiry;
    private abortEnable;
    private now;
}
export {};

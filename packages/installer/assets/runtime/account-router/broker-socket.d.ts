import { AccountsBrokerV1 } from "./broker";
import type { NativeSharedHistoryMapRequestV1, NativeSharedHistoryMapResultV1 } from "./broker-host";
import type { BrokerClientKind, BrokerControlStatusV1, BrokerEventV1, BrokerRequestEnvelopeV1, BrokerResponseV1, OpaqueAppToolsRef, OpaqueRendererRef } from "./types";
export declare const ACCOUNTS_BROKER_SOCKET_FILE = "accounts-broker.v1.sock";
export declare const ACCOUNTS_BROKER_CONTROL_SOCKET_FILE = "broker-control.v1.sock";
export declare const ACCOUNTS_BROKER_SECRET_FILE = "control-secret.v1";
export declare const ACCOUNTS_BROKER_MAX_FRAME_BYTES: number;
/** Bounded, schema-validated projections may contain the full connection catalog. */
export declare const ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES: number;
/** Only a correlated, validated native response may use this payload plus envelope budget. */
export declare const ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES: number;
export declare const ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS = 5000;
/** A command is never replayed after this owner-private response deadline. */
export declare const ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS = 15000;
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
export declare function resolveAccountsBrokerRootResolution(options: AccountsBrokerRootResolutionOptions): AccountsBrokerRootResolution;
/** Compatibility projection for callers that only need the valid root. */
export declare function resolveAccountsBrokerRoot(options: AccountsBrokerRootResolutionOptions): string | null;
export declare function accountsBrokerConfigPath(root: string): string;
export declare function accountsBrokerSocketPath(root: string, socketFileName?: string): string;
/** Read the exact owner-private capability shared by the global broker host. */
export declare function readAccountsBrokerSecret(root: string): Buffer | null;
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
export type DoctorExecutionLeaseAcquireResultV1 = {
    status: "ready";
    leaseId: string;
    opaqueAccountId: string;
    codexHome: string;
} | {
    status: "unavailable";
    reason: DoctorExecutionLeaseUnavailableReason;
};
export type DoctorExecutionLeaseMarkResultV1 = {
    status: "dispatched";
    leaseId: string;
} | {
    status: "unavailable";
    reason: DoctorExecutionLeaseUnavailableReason;
};
export type DoctorExecutionLeaseSettleResultV1 = {
    status: "settled";
    leaseId: string;
    outcome: "pre_dispatch" | "completed" | "ambiguous";
} | {
    status: "unavailable";
    reason: DoctorExecutionLeaseUnavailableReason;
};
export type DoctorExecutionLeaseRequestV1 = {
    version: 1;
    requestId: string;
    action: "prepare_auth_recovery";
} | {
    version: 1;
    requestId: string;
    action: "acquire";
    purpose: "doctor_review";
    estimatedCost: number;
} | {
    version: 1;
    requestId: string;
    action: "mark_dispatched";
    leaseId: string;
} | {
    version: 1;
    requestId: string;
    action: "settle";
    leaseId: string;
    outcome: "pre_dispatch" | "completed" | "ambiguous";
    usage?: {
        inputTokens: number;
        outputTokens: number;
    };
};
export type DoctorExecutionLeaseResultV1 = {
    status: "recovery_ready";
} | DoctorExecutionLeaseAcquireResultV1 | DoctorExecutionLeaseMarkResultV1 | DoctorExecutionLeaseSettleResultV1;
export type NativeBrowserContextV1 = {
    version: 1;
    status: "unavailable";
} | {
    version: 1;
    status: "ready";
    opaqueAccountId: string;
    codexHome: string;
    configFile: string;
    appServerVersion: string;
};
/**
 * A single owner-private, authenticated broker endpoint.  Each peer must
 * prove a fresh opaque renderer/app-tools session before sending a command.
 * JSONL is bounded and every event remains targeted by the broker itself.
 */
export declare function startAccountsBrokerSocket(options: AccountsBrokerSocketOptions): Promise<AccountsBrokerSocket>;
/**
 * Bind the owner-election socket before touching any shared broker state.
 * A contender that cannot bind this endpoint has no authority to recover or
 * mutate the shared root.  While reserved, early client connections are
 * closed so their normal bounded retry can find the activated owner.
 */
export declare function reserveAccountsBrokerSocket(options: Pick<AccountsBrokerSocketOptions, "root" | "secret" | "socketFileName" | "maxFrameBytes">): Promise<AccountsBrokerSocketReservation>;
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
export declare function startBrokerControlSocket(options: BrokerControlSocketOptions): Promise<BrokerControlSocket>;
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
export declare class AccountsBrokerManagerClientV1 {
    private readonly root;
    private readonly secret;
    private readonly socketFileName;
    private readonly maxFrameBytes;
    private readonly sockets;
    private closed;
    constructor(options: AccountsBrokerManagerClientOptions);
    prepareAuthenticationRecovery(requestId: string): Promise<boolean>;
    acquireDoctorReviewLease(input: {
        requestId: string;
        purpose: "doctor_review";
        estimatedCost: number;
    }): Promise<DoctorExecutionLeaseAcquireResultV1>;
    markDoctorReviewLeaseDispatched(input: {
        requestId: string;
        leaseId: string;
    }): Promise<DoctorExecutionLeaseMarkResultV1>;
    settleDoctorReviewLease(input: {
        requestId: string;
        leaseId: string;
        outcome: "pre_dispatch" | "completed" | "ambiguous";
        usage?: {
            inputTokens: number;
            outputTokens: number;
        };
    }): Promise<DoctorExecutionLeaseSettleResultV1>;
    close(): Promise<void>;
    private invoke;
}
/**
 * Main-process-only client.  It never retries a command after a connection
 * loss: the owner consumed its request id before execution, so automatic
 * replay could duplicate a handoff or any later mutating operation.
 */
export declare class AccountsBrokerSocketClientV1 {
    private readonly options;
    private socket;
    private connecting;
    private closed;
    private connected;
    private pending;
    private pendingNativeMaps;
    private pendingNativeBrowser;
    private pendingNativeBrowserRequests;
    private subscribers;
    private buffered;
    private byteLength;
    constructor(options: AccountsBrokerSocketClientOptions);
    invoke(envelope: BrokerRequestEnvelopeV1): Promise<BrokerResponseV1>;
    /** Runtime-owned exact-ID mapping; it is intentionally not a broker command. */
    mapNativeTargets(request: NativeSharedHistoryMapRequestV1): Promise<NativeSharedHistoryMapResultV1>;
    resolveNativeBrowserContext(opaqueAccountId: string): Promise<NativeBrowserContextV1>;
    invokeNativeBrowserRequest(opaqueAccountId: string, method: string, params: Record<string, unknown>): Promise<unknown | null>;
    subscribe(handler: (event: BrokerEventV1) => void): () => void;
    close(): Promise<void>;
    private ensureConnected;
    private open;
    private consumeFrameChunk;
    private failPending;
    private frameBytes;
}
/** Stable hash helper for tests/status agents; no consumer should expose it. */
export declare function accountsBrokerRootHash(root: string): string;

import type { RouterConfig, JsonRpcMessage, OpaqueAccountId, RedactedControlStatus } from "./types";
import type { RouterStateStore } from "./state-store";
export interface RouterChild {
    readonly opaqueAccountId: OpaqueAccountId;
    send(message: JsonRpcMessage): void;
    terminate(signal: NodeJS.Signals): void;
    markInitialized?(): void;
}
export interface RouterChildFactory {
    create(account: OpaqueAccountId, handlers: {
        onMessage(message: JsonRpcMessage): void;
        onFailure(): void;
    }): RouterChild;
}
export declare class RouterPreDispatchError extends Error {
    constructor(message?: string);
}
export interface AccountRouterMuxOptions {
    config: RouterConfig;
    store: RouterStateStore;
    childFactory: RouterChildFactory;
    writeDesktop: (message: JsonRpcMessage) => void;
    controlSecret?: Buffer;
    now?: () => number;
    onFatal?: () => void;
    onShutdown?: () => void;
}
/**
 * The JSONL-only app-server multiplexer. Its public output is restricted to
 * normal JSON-RPC frames and redacted router errors; status/protocol details
 * stay in owner-private state.
 */
export declare class AccountRouterMux {
    private readonly options;
    private readonly children;
    private readonly correlations;
    private readonly ledger;
    private readonly issued;
    private readonly fanouts;
    private readonly pendingReservationsByThread;
    private readonly tokenUsage;
    private readonly refreshInFlight;
    private readonly controlSecret;
    private accepting;
    private started;
    private initialized;
    private precisionEstimated;
    private fatalSignalled;
    private shutdownSignalled;
    constructor(options: AccountRouterMuxOptions);
    start(): boolean;
    receiveDesktopLine(line: string): void;
    receiveDesktop(message: JsonRpcMessage): void;
    status(): RedactedControlStatus;
    shutdown(): void;
    private routeDesktopRequest;
    private initialize;
    private dispatchNewThread;
    private dispatchFanout;
    private childForRoute;
    private dispatchToChild;
    private handleChildMessage;
    private handleChildResponse;
    private recordFanoutResponse;
    private handleChildRequest;
    private routeDesktopResponse;
    private handleChildNotification;
    private recordTokenUsage;
    private reconcileTerminal;
    private invalidateCapabilities;
    private protocolDrift;
    private postStartFailure;
    private signalFatal;
}

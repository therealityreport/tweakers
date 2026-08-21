import type { RedactedControlStatus } from "./types";
export declare const ACCOUNT_ROUTER_CONTROL_SOCKET_FILE = "router-control.v1.sock";
export declare const ACCOUNT_ROUTER_CONTROL_MAX_FRAME_BYTES: number;
export declare const ACCOUNT_ROUTER_CONTROL_TIMEOUT_MS = 2000;
export interface RouterControlSocket {
    readonly path: string;
    close(): Promise<void>;
}
export interface RouterControlSocketOptions {
    root: string;
    secret: Buffer;
    status: () => RedactedControlStatus;
    socketFileName?: string;
    requestTimeoutMs?: number;
    maxFrameBytes?: number;
}
/**
 * Owner-private, local-only status endpoint. One authenticated JSONL request
 * is accepted per Unix connection, so a duplicated frame cannot be replayed
 * within a transport session. The only successful payload is the already
 * redacted status projection.
 */
export declare function startRouterControlSocket(options: RouterControlSocketOptions): Promise<RouterControlSocket>;
/**
 * macOS limits AF_UNIX paths to roughly 104 bytes. The normal account-switcher
 * data root can exceed that, so retain a deterministic logical namespace while
 * locating the endpoint under an owner-private short system-temp directory.
 * The hash contains no credential or provider identity and is not renderer
 * output; T3/T4 can derive the same endpoint from the router data root.
 */
export declare function routerControlSocketPath(root: string, socketFileName?: string): string;

import type { Readable } from "node:stream";
import { type AccountsBrokerAppServerClientOptions, type AccountsBrokerAppServerConnection } from "./broker-host";
import { type OpaqueAppToolsRef, type OpaqueRendererRef, type JsonRpcMessage } from "./types";
export declare const ACCOUNTS_BROKER_STARTUP_TIMEOUT_MS = 20000;
/**
 * Per-desktop stdio client for the shared daemon. It never launches Codex
 * directly: an absent/unavailable broker is a terminal redacted app-server
 * failure, not authority to create a second SQLite writer.
 */
export declare function runAccountsBrokerAppServerCli(argv?: string[]): Promise<void>;
/** Retry only transport establishment. No desktop JSON-RPC is read or replayed. */
export declare function connectAccountsBrokerForStartup(options: AccountsBrokerAppServerClientOptions, onMessage: (message: JsonRpcMessage) => void, deadline: number, launchOwner: () => void): Promise<AccountsBrokerAppServerConnection | null>;
/** One private, bounded frame. Never consume the native JSON-RPC stdin here. */
export declare function readBrokerDesktopIdentityBootstrap(input: Readable, timeoutMs?: number): Promise<{
    rendererRef: OpaqueRendererRef;
    appToolsRef: OpaqueAppToolsRef;
}>;

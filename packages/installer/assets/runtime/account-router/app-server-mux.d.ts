import { type HistoryAdoptionFailure } from "./history-adoption";
import type { RouterConfig } from "./types";
interface MuxShutdownTarget {
    shutdown(): void;
}
/** Shared EOF/signal cleanup: idempotent and deliberately does not close stdin. */
export declare function createMuxCliShutdown(mux: MuxShutdownTarget, closeControl: () => void | Promise<void>, pauseInput: () => void, scheduleForceExit: () => void): () => void;
/** Executable entry point run under ChatGPT's bundled signed Node parent. */
export declare function runAccountRouterMuxCli(argv?: string[]): Promise<void>;
export declare function preflightRouterHomes(config: RouterConfig, stateRoot: string): boolean;
/**
 * Non-secret startup evidence for the parent/direct-fallback decision. File
 * names, homes, identities, and provider data deliberately never escape it.
 */
export declare function preflightRouterHomesDetail(config: RouterConfig, stateRoot: string): {
    ok: true;
} | {
    ok: false;
    reason: HistoryAdoptionFailure | "startup_selfcheck_failed";
};
export declare function sanitizedChildEnvironment(codexHome: string, sqliteHome: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function defaultMuxPaths(userRoot?: string | undefined): {
    configPath: string;
    stateRoot: string;
} | null;
export {};

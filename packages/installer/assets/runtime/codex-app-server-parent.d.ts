import type { ChildProcess, SpawnOptions } from "node:child_process";
declare const INSTALL_MARKER: unique symbol;
/**
 * The native browser peer authorizer validates three generations of process
 * ancestry. A locally re-signed desktop app therefore cannot be the direct
 * grandparent of the signed Codex browser processes. This tiny signed-Node
 * parent keeps the desktop app outside that three-process window without
 * changing the native host or its authorization policy.
 */
export declare const CODEX_APP_SERVER_PARENT_SOURCE: string;
export type SpawnFunction = (command: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions) => ChildProcess;
export interface MutableChildProcessModule {
    spawn: SpawnFunction;
    [INSTALL_MARKER]?: InstalledParent;
}
interface InstalledParent {
    originalSpawn: SpawnFunction;
    wrappedSpawn: SpawnFunction;
    children: Set<ChildProcess>;
    cleanupStarted: boolean;
    cleanupInFlight?: Promise<CodexAppServerParentCleanupResult>;
}
export interface CodexAppServerParentCleanupResult {
    tracked: number;
    terminated: number;
    forced: number;
    failed: number;
}
export interface CodexAppServerParentInstallOptions {
    childProcess?: MutableChildProcessModule;
    resourcesPath?: string;
    platform?: NodeJS.Platform;
    pathExists?: (path: string) => boolean;
    accountRouter?: AccountRouterParentOptions;
}
/**
 * The only parent-visible router input is a redacted, versioned config.  It
 * is read before process creation so invalid/stale state leaves the exact
 * direct app-server parent path reachable without opening a mux session.
 */
export interface AccountRouterParentOptions {
    userRoot?: string;
    configPath?: string | null;
    runtimeEntrypointPath?: string;
    pathExists?: (path: string) => boolean;
    readFile?: (path: string, encoding: BufferEncoding) => string;
}
export interface CodexAppServerParentInstallResult {
    installed: boolean;
    bundledNodePath: string | null;
    reason: "installed" | "already-installed" | "unsupported-platform" | "missing-bundled-node";
    cleanupTrackedParents(options?: {
        termTimeoutMs?: number;
        killTimeoutMs?: number;
    }): Promise<CodexAppServerParentCleanupResult>;
    uninstall(): void;
}
export declare function isCodexAppServerSpawn(command: unknown, args: unknown, options?: SpawnOptions): command is string;
export declare function buildCodexAppServerParentArgs(command: string, args: readonly string[]): string[];
export declare function buildAccountRouterMuxArgs(entrypoint: string, configPath: string, command: string, args: readonly string[]): string[];
export declare function installCodexAppServerParent(options?: CodexAppServerParentInstallOptions): CodexAppServerParentInstallResult;
export {};

import type { ChildProcess, SpawnOptions } from "node:child_process";
declare const INSTALL_MARKER: unique symbol;
export declare const ACCOUNTS_BROKER_IDENTITY_FD_ENV = "TWEAKERS_ACCOUNTS_BROKER_IDENTITY_FD";
export declare const ACCOUNTS_BROKER_IDENTITY_TIMEOUT_MS = 20000;
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
    /** Derived desktop shell: retain only its per-window app-tools MCP. */
    secondaryVariant?: boolean;
    /** Shared task index requested by the derived shell; never renderer-owned. */
    secondaryVariantSharedSqliteHome?: string;
}
/**
 * The only parent-visible router input is a redacted, versioned config.  It
 * is read before process creation so invalid/stale state leaves the exact
 * direct app-server parent path reachable without opening a mux session.
 */
export interface AccountRouterParentOptions {
    userRoot?: string;
    /**
     * Manager-global v3 broker rendezvous root. Derived variants must provide
     * this exact root; they may not derive a variant-local state/config root.
     */
    brokerRoot?: string | null;
    /**
     * Set only by runtime main when either global-root alias was explicitly
     * configured. A true value with no resolved root is a terminal blocked
     * launch, not an absent-global legacy fallback.
     */
    brokerRootConfigured?: boolean;
    configPath?: string | null;
    runtimeEntrypointPath?: string;
    brokerEntrypointPath?: string;
    pathExists?: (path: string) => boolean;
    readFile?: (path: string, encoding: BufferEncoding) => string;
    /**
     * Main-process session identity for the app-server bridge. It is resolved at
     * spawn time so the bridge and Accounts IPC use the same opaque endpoint.
     */
    resolveBrokerDesktopIdentity?: () => {
        rendererRef: string;
        appToolsRef: string;
    } | null;
}
/**
 * The Accounts UI gets only this non-secret, main-owned authority result. It
 * must never infer local-writer permission from whether a broker socket happens
 * to be reachable.
 */
export type AccountsAuthorityMode = "global-v3" | "legacy" | "blocked";
export interface AccountsAuthorityResolutionOptions {
    userRoot?: string;
    /** A resolved manager-global root; it is never sent to a renderer. */
    brokerRoot?: string | null;
    /** Distinguishes an absent broker-root setting from an invalid configured one. */
    brokerRootConfigured?: boolean;
    configPath?: string | null;
    pathExists?: (path: string) => boolean;
    readFile?: (path: string, encoding: BufferEncoding) => string;
}
/**
 * Select the sole Accounts authority before any tweak lifecycle begins.
 *
 * A present manager-global config is a publication boundary: a valid v3 file
 * remains globally authoritative even when its broker is unavailable, while
 * every other present global state blocks local writers.  Only an absent global
 * config plus a valid, launch-preflight-safe local v1/v2 selection can retain
 * the legacy writer.
 */
export declare function resolveAccountsAuthorityMode(options?: AccountsAuthorityResolutionOptions): AccountsAuthorityMode;
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
export declare function buildAccountRouterMuxArgs(entrypoint: string, configPath: string, command: string, args: readonly string[], sharedSqliteHome?: string): string[];
/** V3 uses a shared broker client and deliberately never accepts shared SQLite. */
export declare function buildAccountsBrokerAppServerArgs(entrypoint: string, configPath: string, command: string, args: readonly string[]): string[];
/** A V3 preflight failure is terminal, never permission to launch direct. */
export declare const ACCOUNTS_BROKER_BLOCKED_SOURCE: string;
export declare function buildAccountsBrokerBlockedArgs(): string[];
/**
 * A derived desktop has its own Codex configuration home, but OpenAI's main
 * process still supplies every enabled desktop plugin as a CLI override. Keep
 * the one per-window `codex_app` pipe and remove all other MCP/plugin
 * projections so a side-by-side launch cannot duplicate the primary app's
 * complete child-process fleet.
 */
export declare function secondaryVariantAppServerArgs(args: readonly string[]): string[];
export declare const SECONDARY_VARIANT_REMOTE_CONTROL_DISABLED_ENV = "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED";
export declare function installCodexAppServerParent(options?: CodexAppServerParentInstallOptions): CodexAppServerParentInstallResult;
export {};

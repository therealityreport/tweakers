import { type HistoryAdoptionFailure } from "./history-adoption";
import type { RouterConfig } from "./types";
interface SharedSkillsTreeEntryV1 {
    path: string;
    bytes: number;
    sha256: `sha256:${string}`;
}
interface SharedSkillsTrustedRootV1 {
    path: string;
    device: number;
    inode: number;
    uid: number;
    mode: number;
}
interface SharedSkillsManifestV1 {
    version: 1;
    kind: "account-router-shared-skills";
    directories: readonly string[];
    files: readonly SharedSkillsTreeEntryV1[];
    trustedRoots: readonly SharedSkillsTrustedRootV1[];
    trustedRootsFingerprint: `sha256:${string}`;
    fingerprint: `sha256:${string}`;
}
interface SharedPluginPackageV1 {
    pluginId: string;
    registry: string;
    name: string;
    version: string;
    fingerprint: `sha256:${string}`;
    exclusionsFingerprint: `sha256:${string}`;
    excludedFiles: readonly SharedPluginExcludedFileV1[];
    fileCount: number;
    bytes: number;
}
type SharedPluginExclusionReasonV1 = "credential" | "transient-lock";
interface SharedPluginExcludedFileV1 {
    path: string;
    bytes: number;
    sha256: `sha256:${string}`;
    reason: SharedPluginExclusionReasonV1;
}
interface SharedPluginsManifestV1 {
    version: 1;
    kind: "account-router-shared-plugins";
    inventoryFingerprint: `sha256:${string}`;
    exclusionsFingerprint: `sha256:${string}`;
    packages: readonly SharedPluginPackageV1[];
    fingerprint: `sha256:${string}`;
}
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
/**
 * Materialize the sealed manager-global Skills source into a brand-new,
 * isolated account CODEX_HOME. This is intentionally limited to enrollment
 * staging: an existing account tree is never repaired or overwritten at
 * runtime because a mismatch is evidence of untrusted drift.
 */
export declare function materializeSharedSkillsIntoAccount(stateRoot: string, codexHome: string): boolean;
/** Confirms one account home is an exact read-only materialization of the manager source. */
export declare function sharedSkillsHomeMatches(stateRoot: string, codexHome: string): boolean;
/** Creates the deterministic, non-secret manifest used by migration fixtures and runtime preflight. */
export declare function sharedSkillsManifestForSource(source: string, trustedRoots?: readonly SharedSkillsTrustedRootV1[]): SharedSkillsManifestV1 | null;
export declare const ACCOUNT_ROUTER_SHARED_SKILLS_DIRECTORY = "shared-skills";
export declare const ACCOUNT_ROUTER_SHARED_SKILLS_MANIFEST_FILE = "shared-skills.v1.json";
/** The manager-global plugin cache is immutable; account homes only hold this exact cache link. */
export declare function materializeSharedPluginsIntoAccount(stateRoot: string, codexHome: string): boolean;
/** Verifies both the sealed manager source and an account's one-link projection. */
export declare function sharedPluginsHomeMatches(stateRoot: string, codexHome: string): boolean;
/**
 * Removes inherited plugin enablement and adds only the IDs bound in the
 * sealed manifest. The caller still owns the rest of the app-server command.
 */
export declare function sharedPluginChildArgs(stateRoot: string, args: readonly string[]): string[] | null;
export declare const ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY = "shared-plugins";
export declare const ACCOUNT_ROUTER_SHARED_PLUGINS_MANIFEST_FILE = "shared-plugins.v1.json";
/** Creates a deterministic non-secret fixture manifest before its cache is sealed read-only. */
export declare function sharedPluginsManifestForSource(source: string): SharedPluginsManifestV1 | null;
/**
 * Owner-private enrollment helper only. It uses the same no-follow, bounded
 * auth parser as startup preflight and clears the byte buffer before return.
 * The returned provider account id must remain inside the broker host.
 */
export declare function readOwnerPrivateAuthAccountId(codexHome: string): string | null;
export declare function sanitizedChildEnvironment(codexHome: string, sqliteHome: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function routerChildSqliteHome(accountRoot: string, sharedSqliteHome: string | null): string;
export declare function defaultMuxPaths(userRoot?: string | undefined): {
    configPath: string;
    stateRoot: string;
} | null;
export {};

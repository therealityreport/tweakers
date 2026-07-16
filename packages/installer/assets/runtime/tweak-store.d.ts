import type { TweakManifest } from "@therealityreport/tweakers-sdk";
export declare const DEFAULT_TWEAK_STORE_INDEX_URL = "https://therealityreport.github.io/tweakers/store/index.json";
export declare const TWEAK_STORE_REVIEW_ISSUE_URL = "https://github.com/therealityreport/tweakers/issues/new";
export interface TweakStoreRegistry {
    schemaVersion: 1;
    generatedAt?: string;
    entries: TweakStoreEntry[];
}
export interface TweakStoreEntry {
    id: string;
    manifest: TweakManifest;
    /**
     * An entry can be catalog metadata before its implementation is shipped.
     * Metadata-only entries deliberately omit install coordinates and are never
     * offered to the archive installer.
    */
    available?: boolean;
    /** Remote source coordinates are required only for remote entries. */
    repo?: string;
    approvedCommitSha?: string;
    /** Packaged entries point at the installer-bundled canonical source. */
    source?: TweakStoreSource;
    approvedAt: string;
    approvedBy: string;
    platforms?: TweakStorePlatform[];
    releaseUrl?: string;
    reviewUrl?: string;
}
export type TweakStoreSource = {
    kind: "bundled";
    path: string;
} | {
    kind: "remote";
    repo: string;
    approvedCommitSha: string;
};
/** Canonical project-owned tweak identifiers and source directories. */
export declare const BUNDLED_TWEAK_SOURCE_PATHS: Readonly<Record<string, string>>;
export type TweakHealthStatus = "failed" | "quarantined";
export interface TweakHealthRecord {
    status: TweakHealthStatus;
    updatedAt: string;
    error?: string;
}
/** The user-facing state vocabulary for catalog rows. */
export type TweakStatus = "installed" | "not-installed" | "enabled" | "disabled" | "failed" | "quarantined";
export interface TweakStatusInput {
    installed: boolean;
    enabled: boolean;
    health?: TweakHealthRecord | null;
}
export declare function deriveTweakStatus(input: TweakStatusInput): TweakStatus;
export type TweakStorePlatform = "darwin" | "win32" | "linux";
export interface TweakStorePublishSubmission {
    repo: string;
    defaultBranch: string;
    commitSha: string;
    commitUrl: string;
    manifest?: {
        id?: string;
        name?: string;
        version?: string;
        description?: string;
        iconUrl?: string;
    };
}
export declare function normalizeGitHubRepo(input: string): string;
export declare function normalizeStoreRegistry(input: unknown): TweakStoreRegistry;
export declare function shuffleStoreEntries<T>(entries: readonly T[], randomIndex?: (exclusiveMax: number) => number): T[];
export declare function normalizeStoreEntry(input: unknown): TweakStoreEntry;
export declare function storeArchiveUrl(entry: TweakStoreEntry): string;
export declare function isBundledStoreEntry(entry: TweakStoreEntry): boolean;
/** Resolve a packaged source while rejecting traversal and ID mismatches. */
export declare function resolveBundledTweakPath(packagedTweaksRoot: string, entry: Pick<TweakStoreEntry, "id" | "source">): string;
export declare function buildTweakPublishIssueUrl(submission: TweakStorePublishSubmission): string;
export declare function isFullCommitSha(value: string): boolean;

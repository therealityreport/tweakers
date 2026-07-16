import type { CodexCliLane, CodexFeatureStage, CodexInstallProgress, ParsedCodexFeature } from "./codex-version-types";
export type { CodexCliLane, CodexInstallPhase, CodexInstallProgress } from "./codex-version-types";
export interface CodexCliRelease {
    version: string;
    tag: string;
    assetName: string;
    assetUrl: string;
    digest: string;
    architecture: string;
}
export interface ManagedCodexCliReceipt {
    schemaVersion: 1;
    version: string;
    releaseTag: string;
    digest: string;
    architecture: string;
    relativeDirectory: string;
    binaryRelativePath: string;
    verifiedAt: string;
}
export interface ManagedCodexCliState {
    schemaVersion: 1;
    current: ManagedCodexCliReceipt | null;
    previous: ManagedCodexCliReceipt | null;
    updatedAt: string;
}
export interface CodexCliPaths {
    root: string;
    releases: string;
    staging: string;
    state: string;
    lock: string;
}
export interface ArchiveEntry {
    path: string;
    type: "file" | "directory" | "symlink" | "hardlink" | "device" | "fifo" | string;
    linkPath?: string;
}
export interface CodexCliManagerDependencies {
    now(): Date;
    operationId(): string;
    resolveRelease(): Promise<CodexCliRelease>;
    download(release: CodexCliRelease, destination: string, onBytes?: (bytes: number) => void): Promise<{
        bytes: number;
        digest: string;
    }>;
    listArchive(archive: string): Promise<ArchiveEntry[]>;
    extractArchive(archive: string, destination: string): Promise<void>;
    verifySignature(binary: string): Promise<boolean>;
    probeVersion(binary: string): Promise<string>;
    probeArchitecture(binary: string): Promise<string>;
    onCrashPoint?(point: "before-release-rename" | "after-release-rename" | "before-state-write" | "after-state-write"): void;
}
export interface CodexCliManager {
    installBeta(): Promise<ManagedCodexCliState>;
    rollbackBeta(): Promise<ManagedCodexCliState>;
    recover(): ManagedCodexCliState;
    getState(): ManagedCodexCliState;
    getProgress(): CodexInstallProgress;
    getSelectedBinary(): string | null;
    validateCurrent(): Promise<{
        valid: boolean;
        binary: string | null;
        error?: string;
    }>;
    listManagedVersions(): string[];
    listStagingOperations(): string[];
}
export declare function deriveCodexCliPaths(home: string): CodexCliPaths;
export declare function validateArchiveEntries(entries: ArchiveEntry[]): void;
export declare function createCodexCliManager(input: {
    home: string;
    deps: CodexCliManagerDependencies;
}): CodexCliManager;
export interface BootstrapLaneResult {
    requestedLane: CodexCliLane | null;
    effectiveLane: CodexCliLane;
    binary: string | null;
    userOverridePreserved: boolean;
    fallback: boolean;
    error: string | null;
}
export declare function applyManagedCodexCliLaneAtBootstrap(input: {
    lane?: CodexCliLane | null;
    home: string;
    env?: NodeJS.ProcessEnv;
    validateManagedBinary?: (binary: string, receipt: ManagedCodexCliReceipt) => {
        valid: boolean;
        error?: string;
    };
    persistFailure?: (safeMessage: string) => void;
}): BootstrapLaneResult;
export interface CodexFeatureInventoryEntry extends ParsedCodexFeature {
    stage: CodexFeatureStage;
}
export interface CodexFeatureMutationDependencies {
    inventory(lane: CodexCliLane): Promise<CodexFeatureInventoryEntry[]>;
    binaryPath?(lane: CodexCliLane): string;
    execFile(binary: string, args: string[], options: {
        timeout: number;
        shell: false;
    }): Promise<void>;
}
export declare function mutateCodexFeature(input: {
    lane: CodexCliLane;
    name: string;
    enabled: boolean;
}, deps: CodexFeatureMutationDependencies): Promise<CodexFeatureInventoryEntry[]>;
export declare function sha256Buffer(chunks: Iterable<Uint8Array>): string;

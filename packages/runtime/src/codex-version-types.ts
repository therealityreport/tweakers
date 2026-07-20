export type CodexCliLane = "bundled" | "beta";

export type CodexReleaseChannel = "stable" | "prerelease";

/** Semantic channel measured from an installed CLI version string. */
export type CodexVersionChannel = CodexReleaseChannel | "unknown";

export interface CodexSemanticVersion {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: bigint | null;
  version: string;
  tag: string;
}

export interface CodexReleaseAsset {
  name: string;
  url: string;
  /** Lowercase hexadecimal SHA-256 without an algorithm prefix. */
  digest: string;
}

export interface CodexReleaseInfo {
  version: string;
  tag: string;
  channel: CodexReleaseChannel;
  prerelease: boolean;
  publishedAt: string;
  releaseUrl: string;
  asset: CodexReleaseAsset | null;
  error: string | null;
}

export type CodexFeatureStage =
  | "stable"
  | "experimental"
  | "under-development"
  | "deprecated"
  | "removed";

export interface ParsedCodexFeature {
  name: string;
  stage: CodexFeatureStage;
  enabled: boolean;
}

export type CodexFeatureEffect = "new-session" | "restart" | "none";

export interface CodexFeatureEntry {
  name: string;
  stages: Record<CodexCliLane, CodexFeatureStage | null>;
  enabled: Record<CodexCliLane, boolean | null>;
  selectedLane: CodexCliLane;
  selectedStage: CodexFeatureStage | null;
  selectedEnabled: boolean | null;
  bundledOnly: boolean;
  betaOnly: boolean;
  mutable: boolean;
  supported: boolean;
  effect: CodexFeatureEffect;
}

export interface CodexUpdateAvailability {
  desktopActionable: boolean;
  desktopUpdateAvailable: boolean;
  bundledCliUpdateAvailable: boolean;
  betaCliUpdateAvailable: boolean;
}

export type CodexInstallPhase =
  | "idle"
  | "resolving"
  | "downloading"
  | "verifying-digest"
  | "verifying-signature"
  | "extracting"
  | "probing"
  | "promoting"
  | "rolling-back"
  | "complete"
  | "failed";

export interface CodexInstallProgress {
  operationId: string | null;
  phase: CodexInstallPhase;
  bytes: number;
  version: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CodexDesktopVersionState {
  installedMarketingVersion: string | null;
  installedBuild: string | null;
  latestMarketingVersion: string | null;
  latestBuild: string | null;
  releaseUrl: string | null;
  nativeUpdateLifecycle: string | null;
  nativeUpdateActionable: boolean;
  nativeUpdatePrerequisiteError: string | null;
  updateAvailable: boolean;
}

export interface CodexDesktopVersionProbeInput {
  appVersion?: string | null;
  infoPlistMarketingVersion?: string | null;
  infoPlistBuild?: string | null;
  stateMarketingVersion?: string | null;
  stateBuild?: string | null;
}

export interface CodexInstalledDesktopVersion {
  installedMarketingVersion: string | null;
  installedBuild: string | null;
}

export interface CodexCliVersionState {
  path: string | null;
  version: string | null;
  versionChannel: CodexVersionChannel;
  available: boolean;
  release: CodexReleaseInfo | null;
  managedCurrentVersion: string | null;
  managedPreviousVersion: string | null;
  error: string | null;
}

export interface CodexActiveCliVersionState {
  path: string;
  version: string | null;
  versionChannel: CodexVersionChannel;
  available: boolean;
  lane: CodexCliLane;
  source: "bundled" | "managed-alpha" | "override";
  error: string | null;
}

export interface CodexVersionsSnapshot {
  schemaVersion: 1;
  checkedAt: string;
  fromCache: boolean;
  stale: boolean;
  desktop: CodexDesktopVersionState;
  terminalCli: CodexCliVersionState;
  activeCli: CodexActiveCliVersionState;
  cli: Record<CodexCliLane, CodexCliVersionState>;
  requestedLane: CodexCliLane | null;
  effectiveLane: CodexCliLane;
  userOverridePreserved: boolean;
  fallbackReason: string | null;
  restartRequired: boolean;
  features: CodexFeatureEntry[];
  installProgress: CodexInstallProgress;
  errors: Partial<Record<"desktop" | CodexCliLane, string>>;
  updateAvailable: boolean;
}

export interface GitHubCodexAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

export interface GitHubCodexRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: readonly GitHubCodexAsset[];
}

export interface CodexReleaseCacheEntry {
  schemaVersion: 1;
  currentVersion: string;
  lane: CodexCliLane;
  checkedAt: string;
  release: GitHubCodexRelease;
}

export interface CodexReleaseLookupResult {
  release: CodexReleaseInfo | null;
  checkedAt: string;
  fromCache: boolean;
  stale: boolean;
  error: string | null;
}

export interface CodexCliProbeResult {
  path: string;
  available: boolean;
  version: string | null;
  features: ParsedCodexFeature[] | null;
  error: string | null;
}

export interface CodexProcessResult {
  stdout: string;
  stderr?: string;
}

export interface CodexVersionServiceDependencies {
  currentVersion: string;
  now: () => number;
  readReleaseCache: (lane: CodexCliLane) => Promise<unknown>;
  writeReleaseCache: (lane: CodexCliLane, cache: CodexReleaseCacheEntry) => Promise<void>;
  fetchReleases: (signal: AbortSignal) => Promise<readonly GitHubCodexRelease[]>;
  execFile: (
    binary: string,
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number },
  ) => Promise<CodexProcessResult>;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxOutputBytes?: number;
}

export interface CodexVersionService {
  fetchLatestRelease(
    lane: CodexCliLane,
    options?: { force?: boolean },
  ): Promise<CodexReleaseLookupResult>;
  readCachedRelease(lane: CodexCliLane): Promise<CodexReleaseLookupResult | null>;
  probeCli(binary: string): Promise<CodexCliProbeResult>;
}

import type { CodexCliLane, CodexDesktopVersionProbeInput, CodexFeatureEntry, CodexInstalledDesktopVersion, CodexReleaseAsset, CodexSemanticVersion, CodexUpdateAvailability, CodexVersionChannel, CodexVersionService, CodexVersionServiceDependencies, GitHubCodexRelease, ParsedCodexFeature } from "./codex-version-types.js";
export declare function probeCodexDesktopVersion(input: CodexDesktopVersionProbeInput): CodexInstalledDesktopVersion;
/**
 * Compare OpenAI appcast metadata without invoking the native Sparkle addon.
 * Sparkle build numbers are authoritative when both sides provide them; the
 * dotted marketing version is a safe fallback for older state snapshots.
 */
export declare function isCodexDesktopUpdateNewer(installedMarketingVersion: string | null, installedBuild: string | null, latestMarketingVersion: string | null, latestBuild: string | null): boolean;
export declare function parseCodexVersionTag(tag: string): CodexSemanticVersion | null;
export declare function compareCodexVersions(a: CodexSemanticVersion, b: CodexSemanticVersion): number;
export declare function filterCodexReleases(releases: readonly GitHubCodexRelease[], lane: CodexCliLane): GitHubCodexRelease[];
export declare function selectLatestCodexRelease(releases: readonly GitHubCodexRelease[], lane: CodexCliLane): GitHubCodexRelease | null;
export declare function resolveCodexReleaseAsset(release: GitHubCodexRelease): CodexReleaseAsset;
export declare function parseCodexCliVersion(output: string): string | null;
/**
 * Classify the semantic release channel of the exact installed CLI version.
 * This is deliberately independent of where the binary came from: OpenAI's
 * production desktop app can embed a prerelease Codex CLI.
 */
export declare function codexVersionChannel(version: string | null | undefined): CodexVersionChannel;
export declare function parseCodexFeatureList(output: string): ParsedCodexFeature[];
export declare function buildCodexFeatureUnion(bundled: readonly ParsedCodexFeature[] | null, beta: readonly ParsedCodexFeature[] | null, selectedLane: CodexCliLane, fresh?: Record<CodexCliLane, boolean>): CodexFeatureEntry[];
export declare function computeCodexUpdateAvailable(availability: CodexUpdateAvailability): boolean;
export declare function codexHeading(updateAvailable: boolean): "CODEX" | "CODEX (UPDATE AVAILABLE)";
export declare function createCodexVersionService(dependencies: CodexVersionServiceDependencies): CodexVersionService;

import type {
  CodexCliLane,
  CodexCliProbeResult,
  CodexDesktopVersionProbeInput,
  CodexFeatureEntry,
  CodexFeatureStage,
  CodexInstalledDesktopVersion,
  CodexReleaseAsset,
  CodexReleaseCacheEntry,
  CodexReleaseInfo,
  CodexReleaseLookupResult,
  CodexSemanticVersion,
  CodexUpdateAvailability,
  CodexVersionChannel,
  CodexVersionService,
  CodexVersionServiceDependencies,
  GitHubCodexRelease,
  ParsedCodexFeature,
} from "./codex-version-types.js";

const CODEX_RELEASE_CACHE_SCHEMA_VERSION = 1 as const;
// Alpha releases can move several times in one day. An hourly cache keeps the
// Settings report useful without repeatedly hitting GitHub during one session.
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1_024;
const DARWIN_ARM64_ASSET_NAMES = ["codex-package-aarch64-apple-darwin.tar.gz"] as const;
const EXACT_CODEX_TAG = /^rust-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/;
const EXACT_CLI_VERSION = /^codex-cli ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-alpha\.(?:0|[1-9]\d*))?)\n?$/;
const FEATURE_LINE = /^([A-Za-z0-9_-]+)\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)$/;
const SHA256_DIGEST = /^sha256:([a-fA-F0-9]{64})$/;

export function probeCodexDesktopVersion(
  input: CodexDesktopVersionProbeInput,
): CodexInstalledDesktopVersion {
  return {
    installedMarketingVersion: firstNonEmpty(
      input.appVersion,
      input.infoPlistMarketingVersion,
      input.stateMarketingVersion,
    ),
    installedBuild: firstNonEmpty(input.infoPlistBuild, input.stateBuild),
  };
}

/**
 * Compare OpenAI appcast metadata without invoking the native Sparkle addon.
 * Sparkle build numbers are authoritative when both sides provide them; the
 * dotted marketing version is a safe fallback for older state snapshots.
 */
export function isCodexDesktopUpdateNewer(
  installedMarketingVersion: string | null,
  installedBuild: string | null,
  latestMarketingVersion: string | null,
  latestBuild: string | null,
): boolean {
  const buildComparison = compareNumericVersion(installedBuild, latestBuild);
  if (buildComparison !== null) return buildComparison < 0;
  const marketingComparison = compareNumericVersion(installedMarketingVersion, latestMarketingVersion);
  return marketingComparison !== null && marketingComparison < 0;
}

function compareNumericVersion(installed: string | null, latest: string | null): number | null {
  if (!installed || !latest) return null;
  const left = installed.trim().split(".");
  const right = latest.trim().split(".");
  if (!left.length || !right.length || !left.every(isDecimalSegment) || !right.every(isDecimalSegment)) return null;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = BigInt(left[index] ?? "0");
    const b = BigInt(right[index] ?? "0");
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function isDecimalSegment(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value);
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return null;
}

export function parseCodexVersionTag(tag: string): CodexSemanticVersion | null {
  const match = EXACT_CODEX_TAG.exec(tag);
  if (!match) return null;
  const prerelease = match[4] === undefined ? null : BigInt(match[4]);
  const base = `${match[1]}.${match[2]}.${match[3]}`;
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease,
    version: prerelease === null ? base : `${base}-alpha.${prerelease}`,
    tag,
  };
}

export function compareCodexVersions(a: CodexSemanticVersion, b: CodexSemanticVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  if (a.prerelease > b.prerelease) return 1;
  if (a.prerelease < b.prerelease) return -1;
  return 0;
}

export function filterCodexReleases(
  releases: readonly GitHubCodexRelease[],
  lane: CodexCliLane,
): GitHubCodexRelease[] {
  return releases.filter((release) => {
    if (release.draft) return false;
    const version = parseCodexVersionTag(release.tag_name);
    if (!version) return false;
    const tagIsPrerelease = version.prerelease !== null;
    if (release.prerelease !== tagIsPrerelease) return false;
    return lane === "bundled" ? !tagIsPrerelease : tagIsPrerelease;
  });
}

export function selectLatestCodexRelease(
  releases: readonly GitHubCodexRelease[],
  lane: CodexCliLane,
): GitHubCodexRelease | null {
  let latest: GitHubCodexRelease | null = null;
  let latestVersion: CodexSemanticVersion | null = null;
  for (const release of filterCodexReleases(releases, lane)) {
    const version = parseCodexVersionTag(release.tag_name)!;
    if (!latestVersion || compareCodexVersions(version, latestVersion) > 0) {
      latest = release;
      latestVersion = version;
    }
  }
  return latest;
}

export function resolveCodexReleaseAsset(release: GitHubCodexRelease): CodexReleaseAsset {
  const matches = release.assets.filter((asset) =>
    DARWIN_ARM64_ASSET_NAMES.includes(asset.name as (typeof DARWIN_ARM64_ASSET_NAMES)[number]),
  );
  if (matches.length === 0) throw new Error("missing allowlisted darwin-arm64 asset");
  if (matches.length > 1) throw new Error("duplicate allowlisted darwin-arm64 asset");
  const asset = matches[0]!;
  const digest = asset.digest ? SHA256_DIGEST.exec(asset.digest) : null;
  if (!digest) throw new Error("missing or invalid SHA-256 digest");
  return {
    name: asset.name,
    url: asset.browser_download_url,
    digest: digest[1]!.toLowerCase(),
  };
}

export function parseCodexCliVersion(output: string): string | null {
  return EXACT_CLI_VERSION.exec(output)?.[1] ?? null;
}

/**
 * Classify the semantic release channel of the exact installed CLI version.
 * This is deliberately independent of where the binary came from: OpenAI's
 * production desktop app can embed a prerelease Codex CLI.
 */
export function codexVersionChannel(version: string | null | undefined): CodexVersionChannel {
  if (!version) return "unknown";
  const parsed = parseCodexVersionTag(`rust-v${version}`);
  if (!parsed) return "unknown";
  return parsed.prerelease === null ? "stable" : "prerelease";
}

export function parseCodexFeatureList(output: string): ParsedCodexFeature[] {
  const features: ParsedCodexFeature[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    const match = FEATURE_LINE.exec(line);
    if (!match) throw new Error(`malformed feature line ${index + 1}`);
    const name = match[1]!;
    if (seen.has(name)) throw new Error(`duplicate feature: ${name}`);
    seen.add(name);
    features.push({
      name,
      stage: normalizeFeatureStage(match[2]!),
      enabled: match[3] === "true",
    });
  }
  return features;
}

function normalizeFeatureStage(stage: string): CodexFeatureStage {
  return stage === "under development" ? "under-development" : stage as CodexFeatureStage;
}

export function buildCodexFeatureUnion(
  bundled: readonly ParsedCodexFeature[] | null,
  beta: readonly ParsedCodexFeature[] | null,
  selectedLane: CodexCliLane,
  fresh: Record<CodexCliLane, boolean> = {
    bundled: bundled !== null,
    beta: beta !== null,
  },
): CodexFeatureEntry[] {
  const bundledByName = new Map((bundled ?? []).map((feature) => [feature.name, feature]));
  const betaByName = new Map((beta ?? []).map((feature) => [feature.name, feature]));
  const names = new Set([...bundledByName.keys(), ...betaByName.keys()]);
  return [...names].sort().map((name) => {
    const bundledFeature = bundledByName.get(name) ?? null;
    const betaFeature = betaByName.get(name) ?? null;
    const selectedFeature = selectedLane === "bundled" ? bundledFeature : betaFeature;
    const mutable = fresh[selectedLane] && selectedFeature !== null &&
      selectedFeature.stage !== "deprecated" && selectedFeature.stage !== "removed";
    return {
      name,
      stages: { bundled: bundledFeature?.stage ?? null, beta: betaFeature?.stage ?? null },
      enabled: { bundled: bundledFeature?.enabled ?? null, beta: betaFeature?.enabled ?? null },
      selectedLane,
      selectedStage: selectedFeature?.stage ?? null,
      selectedEnabled: selectedFeature?.enabled ?? null,
      bundledOnly: bundledFeature !== null && betaFeature === null,
      betaOnly: betaFeature !== null && bundledFeature === null,
      mutable,
      supported: selectedFeature !== null,
      effect: mutable ? "new-session" : "none",
    };
  });
}

export function computeCodexUpdateAvailable(availability: CodexUpdateAvailability): boolean {
  return (availability.desktopActionable && availability.desktopUpdateAvailable) ||
    availability.bundledCliUpdateAvailable ||
    availability.betaCliUpdateAvailable;
}

export function codexHeading(updateAvailable: boolean): "CODEX" | "CODEX (UPDATE AVAILABLE)" {
  return updateAvailable ? "CODEX (UPDATE AVAILABLE)" : "CODEX";
}

function releaseInfo(release: GitHubCodexRelease): CodexReleaseInfo {
  const version = parseCodexVersionTag(release.tag_name);
  if (!version) throw new Error("release has an invalid Codex tag");
  let asset: CodexReleaseAsset | null = null;
  let error: string | null = null;
  try {
    asset = resolveCodexReleaseAsset(release);
  } catch (cause) {
    error = safeError(cause);
  }
  return {
    version: version.version,
    tag: version.tag,
    channel: version.prerelease === null ? "stable" : "prerelease",
    prerelease: version.prerelease !== null,
    publishedAt: release.published_at,
    releaseUrl: release.html_url,
    asset,
    error,
  };
}

function isCacheEntry(
  value: unknown,
  lane: CodexCliLane,
  currentVersion: string,
): value is CodexReleaseCacheEntry {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<CodexReleaseCacheEntry>;
  return cache.schemaVersion === CODEX_RELEASE_CACHE_SCHEMA_VERSION &&
    cache.currentVersion === currentVersion &&
    cache.lane === lane &&
    typeof cache.checkedAt === "string" &&
    Number.isFinite(Date.parse(cache.checkedAt)) &&
    isGitHubCodexRelease(cache.release) &&
    filterCodexReleases([cache.release], lane).length === 1;
}

function isGitHubCodexRelease(value: unknown): value is GitHubCodexRelease {
  if (!value || typeof value !== "object") return false;
  const release = value as Partial<GitHubCodexRelease>;
  return typeof release.tag_name === "string" &&
    typeof release.draft === "boolean" &&
    typeof release.prerelease === "boolean" &&
    typeof release.published_at === "string" &&
    typeof release.html_url === "string" &&
    Array.isArray(release.assets) &&
    release.assets.every((asset) =>
      !!asset &&
      typeof asset.name === "string" &&
      typeof asset.browser_download_url === "string" &&
      (asset.digest === undefined || asset.digest === null || typeof asset.digest === "string")
    );
}

function safeError(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return "unknown error";
}

function lookupFromCache(cache: CodexReleaseCacheEntry, now: number, ttlMs: number): CodexReleaseLookupResult {
  return {
    release: releaseInfo(cache.release),
    checkedAt: cache.checkedAt,
    fromCache: true,
    stale: now - Date.parse(cache.checkedAt) >= ttlMs,
    error: null,
  };
}

export function createCodexVersionService(
  dependencies: CodexVersionServiceDependencies,
): CodexVersionService {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = dependencies.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxOutputBytes = dependencies.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  async function readCache(lane: CodexCliLane): Promise<CodexReleaseCacheEntry | null> {
    try {
      const value = await dependencies.readReleaseCache(lane);
      return isCacheEntry(value, lane, dependencies.currentVersion) ? value : null;
    } catch {
      return null;
    }
  }

  return {
    async readCachedRelease(lane) {
      const cache = await readCache(lane);
      return cache ? lookupFromCache(cache, dependencies.now(), cacheTtlMs) : null;
    },

    async fetchLatestRelease(lane, options = {}) {
      const now = dependencies.now();
      const cache = await readCache(lane);
      if (cache && !options.force) {
        const cached = lookupFromCache(cache, now, cacheTtlMs);
        if (!cached.stale) return cached;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const releases = await Promise.race([
          dependencies.fetchReleases(controller.signal),
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(new Error("release check timed out")), {
              once: true,
            });
          }),
        ]);
        const latest = selectLatestCodexRelease(releases, lane);
        if (!latest) throw new Error(`no ${lane === "bundled" ? "stable" : "prerelease"} Codex release found`);
        const latestInfo = releaseInfo(latest);
        if (latestInfo.error || !latestInfo.asset) {
          throw new Error(latestInfo.error ?? "release is missing an installable asset");
        }
        const checkedAt = new Date(now).toISOString();
        let cacheError: string | null = null;
        try {
          await dependencies.writeReleaseCache(lane, {
            schemaVersion: CODEX_RELEASE_CACHE_SCHEMA_VERSION,
            currentVersion: dependencies.currentVersion,
            lane,
            checkedAt,
            release: latest,
          });
        } catch (cause) {
          cacheError = `${lane}: could not cache release metadata: ${safeError(cause)}`;
        }
        return {
          release: latestInfo,
          checkedAt,
          fromCache: false,
          stale: false,
          error: cacheError,
        };
      } catch (cause) {
        const error = `${lane}: ${safeError(cause)}`;
        if (cache) {
          return { ...lookupFromCache(cache, now, cacheTtlMs), stale: true, error };
        }
        return {
          release: null,
          checkedAt: new Date(now).toISOString(),
          fromCache: false,
          stale: true,
          error,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    async probeCli(binary): Promise<CodexCliProbeResult> {
      try {
        const versionResult = await dependencies.execFile(binary, ["--version"], { timeoutMs, maxOutputBytes });
        const version = parseCodexCliVersion(versionResult.stdout);
        if (!version) throw new Error("Codex CLI returned an invalid version");
        const featureResult = await dependencies.execFile(binary, ["features", "list"], {
          timeoutMs,
          maxOutputBytes,
        });
        return {
          path: binary,
          available: true,
          version,
          features: parseCodexFeatureList(featureResult.stdout),
          error: null,
        };
      } catch (cause) {
        const error = cause as NodeJS.ErrnoException;
        return {
          path: binary,
          available: false,
          version: null,
          features: null,
          error: error.code === "ENOENT"
            ? "Codex CLI is not installed at the expected path."
            : `Codex CLI probe failed: ${safeError(cause)}`,
        };
      }
    },
  };
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeCodexDesktopVersion = probeCodexDesktopVersion;
exports.isCodexDesktopUpdateNewer = isCodexDesktopUpdateNewer;
exports.parseCodexVersionTag = parseCodexVersionTag;
exports.compareCodexVersions = compareCodexVersions;
exports.filterCodexReleases = filterCodexReleases;
exports.selectLatestCodexRelease = selectLatestCodexRelease;
exports.resolveCodexReleaseAsset = resolveCodexReleaseAsset;
exports.parseCodexCliVersion = parseCodexCliVersion;
exports.parseCodexFeatureList = parseCodexFeatureList;
exports.buildCodexFeatureUnion = buildCodexFeatureUnion;
exports.computeCodexUpdateAvailable = computeCodexUpdateAvailable;
exports.codexHeading = codexHeading;
exports.createCodexVersionService = createCodexVersionService;
const CODEX_RELEASE_CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1_024;
const DARWIN_ARM64_ASSET_NAMES = ["codex-package-aarch64-apple-darwin.tar.gz"];
const EXACT_CODEX_TAG = /^rust-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/;
const EXACT_CLI_VERSION = /^codex-cli ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-alpha\.(?:0|[1-9]\d*))?)\n?$/;
const FEATURE_LINE = /^([A-Za-z0-9_-]+)\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)$/;
const SHA256_DIGEST = /^sha256:([a-fA-F0-9]{64})$/;
function probeCodexDesktopVersion(input) {
    return {
        installedMarketingVersion: firstNonEmpty(input.appVersion, input.infoPlistMarketingVersion, input.stateMarketingVersion),
        installedBuild: firstNonEmpty(input.infoPlistBuild, input.stateBuild),
    };
}
/**
 * Compare OpenAI appcast metadata without invoking the native Sparkle addon.
 * Sparkle build numbers are authoritative when both sides provide them; the
 * dotted marketing version is a safe fallback for older state snapshots.
 */
function isCodexDesktopUpdateNewer(installedMarketingVersion, installedBuild, latestMarketingVersion, latestBuild) {
    const buildComparison = compareNumericVersion(installedBuild, latestBuild);
    if (buildComparison !== null)
        return buildComparison < 0;
    const marketingComparison = compareNumericVersion(installedMarketingVersion, latestMarketingVersion);
    return marketingComparison !== null && marketingComparison < 0;
}
function compareNumericVersion(installed, latest) {
    if (!installed || !latest)
        return null;
    const left = installed.trim().split(".");
    const right = latest.trim().split(".");
    if (!left.length || !right.length || !left.every(isDecimalSegment) || !right.every(isDecimalSegment))
        return null;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const a = BigInt(left[index] ?? "0");
        const b = BigInt(right[index] ?? "0");
        if (a < b)
            return -1;
        if (a > b)
            return 1;
    }
    return 0;
}
function isDecimalSegment(value) {
    return /^(?:0|[1-9]\d*)$/.test(value);
}
function firstNonEmpty(...values) {
    for (const value of values) {
        const normalized = value?.trim();
        if (normalized)
            return normalized;
    }
    return null;
}
function parseCodexVersionTag(tag) {
    const match = EXACT_CODEX_TAG.exec(tag);
    if (!match)
        return null;
    const prerelease = match[4] === undefined ? null : BigInt(match[4]);
    const base = `${match[1]}.${match[2]}.${match[3]}`;
    return {
        major: BigInt(match[1]),
        minor: BigInt(match[2]),
        patch: BigInt(match[3]),
        prerelease,
        version: prerelease === null ? base : `${base}-alpha.${prerelease}`,
        tag,
    };
}
function compareCodexVersions(a, b) {
    for (const key of ["major", "minor", "patch"]) {
        if (a[key] > b[key])
            return 1;
        if (a[key] < b[key])
            return -1;
    }
    if (a.prerelease === null && b.prerelease === null)
        return 0;
    if (a.prerelease === null)
        return 1;
    if (b.prerelease === null)
        return -1;
    if (a.prerelease > b.prerelease)
        return 1;
    if (a.prerelease < b.prerelease)
        return -1;
    return 0;
}
function filterCodexReleases(releases, lane) {
    return releases.filter((release) => {
        if (release.draft)
            return false;
        const version = parseCodexVersionTag(release.tag_name);
        if (!version)
            return false;
        const tagIsPrerelease = version.prerelease !== null;
        if (release.prerelease !== tagIsPrerelease)
            return false;
        return lane === "bundled" ? !tagIsPrerelease : tagIsPrerelease;
    });
}
function selectLatestCodexRelease(releases, lane) {
    let latest = null;
    let latestVersion = null;
    for (const release of filterCodexReleases(releases, lane)) {
        const version = parseCodexVersionTag(release.tag_name);
        if (!latestVersion || compareCodexVersions(version, latestVersion) > 0) {
            latest = release;
            latestVersion = version;
        }
    }
    return latest;
}
function resolveCodexReleaseAsset(release) {
    const matches = release.assets.filter((asset) => DARWIN_ARM64_ASSET_NAMES.includes(asset.name));
    if (matches.length === 0)
        throw new Error("missing allowlisted darwin-arm64 asset");
    if (matches.length > 1)
        throw new Error("duplicate allowlisted darwin-arm64 asset");
    const asset = matches[0];
    const digest = asset.digest ? SHA256_DIGEST.exec(asset.digest) : null;
    if (!digest)
        throw new Error("missing or invalid SHA-256 digest");
    return {
        name: asset.name,
        url: asset.browser_download_url,
        digest: digest[1].toLowerCase(),
    };
}
function parseCodexCliVersion(output) {
    return EXACT_CLI_VERSION.exec(output)?.[1] ?? null;
}
function parseCodexFeatureList(output) {
    const features = [];
    const seen = new Set();
    const lines = output.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() === "")
            continue;
        const match = FEATURE_LINE.exec(line);
        if (!match)
            throw new Error(`malformed feature line ${index + 1}`);
        const name = match[1];
        if (seen.has(name))
            throw new Error(`duplicate feature: ${name}`);
        seen.add(name);
        features.push({
            name,
            stage: normalizeFeatureStage(match[2]),
            enabled: match[3] === "true",
        });
    }
    return features;
}
function normalizeFeatureStage(stage) {
    return stage === "under development" ? "under-development" : stage;
}
function buildCodexFeatureUnion(bundled, beta, selectedLane, fresh = {
    bundled: bundled !== null,
    beta: beta !== null,
}) {
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
function computeCodexUpdateAvailable(availability) {
    return (availability.desktopActionable && availability.desktopUpdateAvailable) ||
        availability.bundledCliUpdateAvailable ||
        availability.betaCliUpdateAvailable;
}
function codexHeading(updateAvailable) {
    return updateAvailable ? "CODEX (UPDATE AVAILABLE)" : "CODEX";
}
function releaseInfo(release) {
    const version = parseCodexVersionTag(release.tag_name);
    if (!version)
        throw new Error("release has an invalid Codex tag");
    let asset = null;
    let error = null;
    try {
        asset = resolveCodexReleaseAsset(release);
    }
    catch (cause) {
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
function isCacheEntry(value, lane, currentVersion) {
    if (!value || typeof value !== "object")
        return false;
    const cache = value;
    return cache.schemaVersion === CODEX_RELEASE_CACHE_SCHEMA_VERSION &&
        cache.currentVersion === currentVersion &&
        cache.lane === lane &&
        typeof cache.checkedAt === "string" &&
        Number.isFinite(Date.parse(cache.checkedAt)) &&
        isGitHubCodexRelease(cache.release) &&
        filterCodexReleases([cache.release], lane).length === 1;
}
function isGitHubCodexRelease(value) {
    if (!value || typeof value !== "object")
        return false;
    const release = value;
    return typeof release.tag_name === "string" &&
        typeof release.draft === "boolean" &&
        typeof release.prerelease === "boolean" &&
        typeof release.published_at === "string" &&
        typeof release.html_url === "string" &&
        Array.isArray(release.assets) &&
        release.assets.every((asset) => !!asset &&
            typeof asset.name === "string" &&
            typeof asset.browser_download_url === "string" &&
            (asset.digest === undefined || asset.digest === null || typeof asset.digest === "string"));
}
function safeError(cause) {
    if (cause instanceof Error && cause.message)
        return cause.message;
    return "unknown error";
}
function lookupFromCache(cache, now, ttlMs) {
    return {
        release: releaseInfo(cache.release),
        checkedAt: cache.checkedAt,
        fromCache: true,
        stale: now - Date.parse(cache.checkedAt) >= ttlMs,
        error: null,
    };
}
function createCodexVersionService(dependencies) {
    const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cacheTtlMs = dependencies.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const maxOutputBytes = dependencies.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    async function readCache(lane) {
        try {
            const value = await dependencies.readReleaseCache(lane);
            return isCacheEntry(value, lane, dependencies.currentVersion) ? value : null;
        }
        catch {
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
                if (!cached.stale)
                    return cached;
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const releases = await Promise.race([
                    dependencies.fetchReleases(controller.signal),
                    new Promise((_resolve, reject) => {
                        controller.signal.addEventListener("abort", () => reject(new Error("release check timed out")), {
                            once: true,
                        });
                    }),
                ]);
                const latest = selectLatestCodexRelease(releases, lane);
                if (!latest)
                    throw new Error(`no ${lane === "bundled" ? "stable" : "prerelease"} Codex release found`);
                const latestInfo = releaseInfo(latest);
                if (latestInfo.error || !latestInfo.asset) {
                    throw new Error(latestInfo.error ?? "release is missing an installable asset");
                }
                const checkedAt = new Date(now).toISOString();
                let cacheError = null;
                try {
                    await dependencies.writeReleaseCache(lane, {
                        schemaVersion: CODEX_RELEASE_CACHE_SCHEMA_VERSION,
                        currentVersion: dependencies.currentVersion,
                        lane,
                        checkedAt,
                        release: latest,
                    });
                }
                catch (cause) {
                    cacheError = `${lane}: could not cache release metadata: ${safeError(cause)}`;
                }
                return {
                    release: latestInfo,
                    checkedAt,
                    fromCache: false,
                    stale: false,
                    error: cacheError,
                };
            }
            catch (cause) {
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
            }
            finally {
                clearTimeout(timer);
            }
        },
        async probeCli(binary) {
            try {
                const versionResult = await dependencies.execFile(binary, ["--version"], { timeoutMs, maxOutputBytes });
                const version = parseCodexCliVersion(versionResult.stdout);
                if (!version)
                    throw new Error("Codex CLI returned an invalid version");
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
            }
            catch (cause) {
                const error = cause;
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
//# sourceMappingURL=codex-version-service.js.map
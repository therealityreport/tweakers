export type CodexSourceChannel = "bundled" | "stable" | "edge";

export const CODEX_RELEASE_REPOSITORY = "openai/codex" as const;
export const CODEX_GITHUB_API_VERSION = "2022-11-28" as const;
export const CODEX_RELEASE_API_ROOT =
  `https://api.github.com/repos/${CODEX_RELEASE_REPOSITORY}/releases` as const;

const CODEX_TAG_PREFIX = "rust-v";
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ParsedCodexSemver {
  raw: string;
  normalized: string;
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly string[];
  build: readonly string[];
}

export interface GitHubReleaseRecord {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  html_url?: unknown;
}

export interface CodexReleaseSelection {
  channel: CodexSourceChannel;
  tag: string;
  version: string;
  prerelease: boolean;
  releaseUrl: string | null;
}

export interface GitHubJsonRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
}

export interface GitHubJsonResponse<T = unknown> {
  status: number;
  data?: T;
  etag?: string | null;
  /** SHA-256 of the exact response bytes, computed by the transport adapter. */
  bodySha256?: string | null;
  /** The absolute next-page URL parsed from GitHub's Link response header. */
  nextUrl?: string | null;
  rateLimited?: boolean;
}

export type GitHubJsonFetcher = <T = unknown>(request: GitHubJsonRequest) => Promise<GitHubJsonResponse<T>>;

export interface CodexReleaseResolution {
  channel: CodexSourceChannel;
  endpoint: string;
  resolvedTag: string;
  normalizedVersion: string;
  releaseUrl: string | null;
  checkedAt: string;
  etag: string | null;
  responseBodySha256: string | null;
}

export interface AdvisoryCache {
  etag?: string | null;
  lastKnownVersion?: string | null;
  lastKnownTag?: string | null;
}

export type AdvisoryDetectionResult =
  | {
      status: "not-modified";
      channel: CodexSourceChannel;
      endpoint: string;
      checkedAt: string;
      etag: string | null;
    }
  | {
      status: "observed";
      channel: CodexSourceChannel;
      endpoint: string;
      checkedAt: string;
      etag: string | null;
      selection: CodexReleaseSelection;
      newer: boolean;
    }
  | {
      status: "skipped";
      channel: CodexSourceChannel;
      endpoint: string;
      checkedAt: string;
      etag: string | null;
      reason: "offline" | "rate-limited" | "server-error" | "invalid-response";
    };

export interface GitObjectIdentity {
  sha: string;
  type: "commit" | "tag";
  url?: string;
}

export interface TagPeelIdentity {
  tag: string;
  refSha: string;
  tagObjectShas: readonly string[];
  peeledCommit: string;
}

export type GitTagObjectFetcher = (sha: string) => Promise<GitObjectIdentity>;

export interface NpmAgreement {
  status: "corroborated" | "npm-behind" | "npm-unavailable" | "abort-npm-ahead";
  githubVersion: string;
  npmVersion: string | null;
  warning: string | null;
}

export interface ChannelPromotionFloor {
  version: string;
  peeledCommit: string;
}

export function parseSemver(value: string): ParsedCodexSemver | null {
  const match = SEMVER_RE.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  const build = match[5]?.split(".") ?? [];
  const core = `${match[1]}.${match[2]}.${match[3]}`;
  return {
    raw: value,
    normalized: `${core}${prerelease.length ? `-${prerelease.join(".")}` : ""}${build.length ? `+${build.join(".")}` : ""}`,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
    build,
  };
}

/** Parse an exact official Codex source tag, stripping only the `rust-v` prefix. */
export function parseCodexReleaseTag(tag: string): ParsedCodexSemver | null {
  if (!tag.startsWith(CODEX_TAG_PREFIX)) return null;
  return parseSemver(tag.slice(CODEX_TAG_PREFIX.length));
}

export function compareSemverPrecedence(a: string | ParsedCodexSemver, b: string | ParsedCodexSemver): number {
  const left = typeof a === "string" ? parseSemver(a) : a;
  const right = typeof b === "string" ? parseSemver(b) : b;
  if (!left || !right) throw new Error("Cannot compare invalid semantic versions");
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] > right[key]) return 1;
    if (left[key] < right[key]) return -1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = left.prerelease[index];
    const rightId = right.prerelease[index];
    if (leftId === undefined || rightId === undefined) return leftId === undefined ? -1 : 1;
    if (leftId === rightId) continue;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) return BigInt(leftId) > BigInt(rightId) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftId > rightId ? 1 : -1;
  }
  return 0;
}

export function selectStableRelease(release: GitHubReleaseRecord): CodexReleaseSelection {
  const selection = releaseSelection(release, "stable");
  if (!selection) {
    throw new Error("GitHub latest release is not a published, non-prerelease rust-v SemVer release");
  }
  return selection;
}

/** Resolve the exact backend version embedded by the installed desktop frontend. */
export function selectBundledRelease(
  release: GitHubReleaseRecord,
  bundledVersion: string,
): CodexReleaseSelection {
  const parsed = parseSemver(bundledVersion);
  if (!parsed) throw new Error(`Invalid bundled Codex version: ${bundledVersion}`);
  const selection = releaseSelection(release, "bundled");
  const expectedTag = `${CODEX_TAG_PREFIX}${parsed.normalized}`;
  if (!selection || selection.tag !== expectedTag || selection.version !== parsed.normalized) {
    throw new Error(`GitHub did not publish the exact bundled Codex tag ${expectedTag}`);
  }
  return selection;
}

export function selectEdgeRelease(releases: readonly GitHubReleaseRecord[]): CodexReleaseSelection {
  const candidates = releases
    .map((release) => releaseSelection(release, "edge"))
    .filter((release): release is CodexReleaseSelection => release !== null);
  if (candidates.length === 0) throw new Error("No published rust-v SemVer Codex releases were found");
  return candidates.reduce((highest, candidate) =>
    compareSemverPrecedence(candidate.version, highest.version) > 0 ? candidate : highest
  );
}

/**
 * A one-request advisory check. Stable reads releases/latest; edge intentionally
 * checks only the first releases page so the daily detector can never become a
 * heavy authoritative resolution path.
 */
export async function detectCodexReleaseAdvisory(input: {
  channel: CodexSourceChannel;
  bundledVersion?: string;
  fetchJson: GitHubJsonFetcher;
  cache?: AdvisoryCache;
  now?: () => string;
}): Promise<AdvisoryDetectionResult> {
  const endpoint = detectionEndpoint(input.channel, input.bundledVersion);
  const checkedAt = (input.now ?? (() => new Date().toISOString()))();
  const headers = githubHeaders(input.cache?.etag);
  let response: GitHubJsonResponse;
  try {
    response = await input.fetchJson({ url: endpoint, headers });
  } catch {
    return skippedDetection(input.channel, endpoint, checkedAt, input.cache?.etag ?? null, "offline");
  }
  const etag = response.etag ?? input.cache?.etag ?? null;
  if (response.status === 304) {
    return { status: "not-modified", channel: input.channel, endpoint, checkedAt, etag };
  }
  if (response.status === 403 || response.status === 429 || response.rateLimited) {
    return skippedDetection(input.channel, endpoint, checkedAt, etag, "rate-limited");
  }
  if (response.status >= 500) {
    return skippedDetection(input.channel, endpoint, checkedAt, etag, "server-error");
  }
  if (response.status !== 200) {
    return skippedDetection(input.channel, endpoint, checkedAt, etag, "invalid-response");
  }
  let selection: CodexReleaseSelection;
  try {
    selection = input.channel === "bundled"
      ? selectBundledRelease(asRelease(response.data), requireBundledVersion(input.bundledVersion))
      : input.channel === "stable"
        ? selectStableRelease(asRelease(response.data))
        : selectEdgeRelease(asReleaseList(response.data));
  } catch {
    return skippedDetection(input.channel, endpoint, checkedAt, etag, "invalid-response");
  }
  const lastKnown = input.cache?.lastKnownVersion;
  let newer = true;
  if (lastKnown) {
    try {
      newer = compareSemverPrecedence(selection.version, lastKnown) > 0;
    } catch {
      // A corrupt advisory cache must not make the daily detector fail closed.
      newer = true;
    }
  }
  return { status: "observed", channel: input.channel, endpoint, checkedAt, etag, selection, newer };
}

/** Authoritative build-path resolver. Edge follows every GitHub releases page. */
export async function resolveCodexSourceRelease(input: {
  channel: CodexSourceChannel;
  bundledVersion?: string;
  fetchJson: GitHubJsonFetcher;
  now?: () => string;
}): Promise<CodexReleaseResolution> {
  const endpoint = detectionEndpoint(input.channel, input.bundledVersion);
  const checkedAt = (input.now ?? (() => new Date().toISOString()))();
  if (input.channel === "bundled" || input.channel === "stable") {
    const response = await input.fetchJson({ url: endpoint, headers: githubHeaders() });
    assertResolutionResponse(response, endpoint);
    const selected = input.channel === "bundled"
      ? selectBundledRelease(asRelease(response.data), requireBundledVersion(input.bundledVersion))
      : selectStableRelease(asRelease(response.data));
    return resolutionFrom(selected, endpoint, checkedAt, response.etag, response.bodySha256);
  }

  const releases: GitHubReleaseRecord[] = [];
  let url: string | null = endpoint;
  let firstEtag: string | null = null;
  let firstBodySha256: string | null = null;
  const visited = new Set<string>();
  while (url) {
    if (visited.has(url)) throw new Error(`GitHub releases pagination cycle at ${url}`);
    visited.add(url);
    const response: GitHubJsonResponse = await input.fetchJson({ url, headers: githubHeaders() });
    assertResolutionResponse(response, url);
    if (visited.size === 1) {
      firstEtag = response.etag ?? null;
      firstBodySha256 = response.bodySha256 ?? null;
    }
    releases.push(...asReleaseList(response.data));
    url = response.nextUrl ?? null;
  }
  return resolutionFrom(selectEdgeRelease(releases), endpoint, checkedAt, firstEtag, firstBodySha256);
}

export async function peelCodexTag(input: {
  tag: string;
  ref: GitObjectIdentity;
  fetchTagObject: GitTagObjectFetcher;
  maxDepth?: number;
}): Promise<TagPeelIdentity> {
  if (!parseCodexReleaseTag(input.tag)) throw new Error(`Invalid Codex release tag: ${input.tag}`);
  assertGitIdentity(input.ref);
  const refSha = input.ref.sha;
  const tagObjectShas: string[] = [];
  const visited = new Set<string>();
  let object = input.ref;
  const maxDepth = input.maxDepth ?? 16;
  while (object.type === "tag") {
    if (tagObjectShas.length >= maxDepth) throw new Error(`Tag peel depth exceeded for ${input.tag}`);
    if (visited.has(object.sha)) throw new Error(`Tag peel cycle detected for ${input.tag}`);
    visited.add(object.sha);
    tagObjectShas.push(object.sha);
    object = await input.fetchTagObject(object.sha);
    assertGitIdentity(object);
  }
  return { tag: input.tag, refSha, tagObjectShas, peeledCommit: object.sha };
}

export function assertTagIdentityStable(checkpoints: readonly TagPeelIdentity[]): void {
  const commits = new Map<string, string>();
  for (const checkpoint of checkpoints) {
    const existing = commits.get(checkpoint.tag);
    if (existing && existing !== checkpoint.peeledCommit) {
      throw new Error(
        `Codex tag drift: ${checkpoint.tag} changed from ${existing} to ${checkpoint.peeledCommit}`,
      );
    }
    commits.set(checkpoint.tag, checkpoint.peeledCommit);
  }
}

export function evaluateNpmAgreement(input: {
  channel: CodexSourceChannel;
  githubVersion: string;
  npmVersions: readonly string[] | null;
}): NpmAgreement {
  const github = parseSemver(input.githubVersion);
  if (!github) throw new Error(`Invalid GitHub version: ${input.githubVersion}`);
  if (input.npmVersions === null) {
    return {
      status: "npm-unavailable",
      githubVersion: github.normalized,
      npmVersion: null,
      warning: "npm corroboration unavailable; GitHub tag commit remains authoritative",
    };
  }
  const npmVersion = input.channel === "bundled"
    ? input.npmVersions.map(parseSemver).find((version) => version?.normalized === github.normalized)?.normalized ?? null
    : highestChannelVersion(input.npmVersions, input.channel);
  if (!npmVersion) {
    return {
      status: "npm-behind",
      githubVersion: github.normalized,
      npmVersion: null,
      warning: "npm has no channel-equivalent Codex release; proceeding from GitHub source",
    };
  }
  const comparison = compareSemverPrecedence(npmVersion, github);
  if (comparison > 0) {
    return {
      status: "abort-npm-ahead",
      githubVersion: github.normalized,
      npmVersion,
      warning: `npm ${npmVersion} is ahead of GitHub ${github.normalized}`,
    };
  }
  if (comparison < 0) {
    return {
      status: "npm-behind",
      githubVersion: github.normalized,
      npmVersion,
      warning: `npm ${npmVersion} lags GitHub ${github.normalized}; proceeding from GitHub source`,
    };
  }
  return {
    status: "corroborated",
    githubVersion: github.normalized,
    npmVersion,
    warning: null,
  };
}

export function assertNpmDoesNotLead(agreement: NpmAgreement): void {
  if (agreement.status === "abort-npm-ahead") throw new Error(agreement.warning ?? "npm is ahead of GitHub");
}

export function assertChannelPromotionAllowed(input: {
  channel: CodexSourceChannel;
  candidateVersion: string;
  candidateCommit: string;
  floors: Partial<Record<CodexSourceChannel, ChannelPromotionFloor>>;
  exactRollback?: ChannelPromotionFloor | null;
}): void {
  const candidate = parseSemver(input.candidateVersion);
  if (!candidate) throw new Error(`Invalid candidate version: ${input.candidateVersion}`);
  if (
    input.exactRollback
    && candidate.normalized === input.exactRollback.version
    && input.candidateCommit === input.exactRollback.peeledCommit
  ) return;
  const floor = input.floors[input.channel];
  if (!floor) return;
  const comparison = compareSemverPrecedence(candidate, floor.version);
  if (comparison < 0) {
    throw new Error(
      `Codex ${input.channel} downgrade refused: ${candidate.normalized} is below ${floor.version}`,
    );
  }
  if (comparison === 0 && input.candidateCommit !== floor.peeledCommit) {
    throw new Error(
      `Codex ${input.channel} identity drift: ${candidate.normalized} maps to a different commit`,
    );
  }
}

function releaseSelection(
  release: GitHubReleaseRecord,
  channel: CodexSourceChannel,
): CodexReleaseSelection | null {
  if (release.draft !== false || typeof release.published_at !== "string" || release.published_at.length === 0) {
    return null;
  }
  if (typeof release.prerelease !== "boolean") return null;
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const parsed = parseCodexReleaseTag(tag);
  if (!parsed) return null;
  if (channel === "stable" && (release.prerelease !== false || parsed.prerelease.length > 0)) return null;
  return {
    channel,
    tag,
    version: parsed.normalized,
    prerelease: parsed.prerelease.length > 0,
    releaseUrl: typeof release.html_url === "string" ? release.html_url : null,
  };
}

function highestChannelVersion(versions: readonly string[], channel: CodexSourceChannel): string | null {
  if (channel === "bundled") return null;
  const parsed = versions
    .map((version) => parseSemver(version))
    .filter((version): version is ParsedCodexSemver =>
      version !== null && (channel === "edge" || version.prerelease.length === 0)
    );
  if (parsed.length === 0) return null;
  return parsed.reduce((highest, candidate) =>
    compareSemverPrecedence(candidate, highest) > 0 ? candidate : highest
  ).normalized;
}

function detectionEndpoint(channel: CodexSourceChannel, bundledVersion?: string): string {
  if (channel === "bundled") {
    const version = requireBundledVersion(bundledVersion);
    return `${CODEX_RELEASE_API_ROOT}/tags/${CODEX_TAG_PREFIX}${encodeURIComponent(version)}`;
  }
  return channel === "stable" ? `${CODEX_RELEASE_API_ROOT}/latest` : `${CODEX_RELEASE_API_ROOT}?per_page=100`;
}

function requireBundledVersion(value: string | undefined): string {
  const parsed = value ? parseSemver(value) : null;
  if (!parsed) throw new Error("The bundled channel requires an exact installed backend version");
  return parsed.normalized;
}

function githubHeaders(etag?: string | null): Readonly<Record<string, string>> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": CODEX_GITHUB_API_VERSION,
    ...(etag ? { "If-None-Match": etag } : {}),
  };
}

function resolutionFrom(
  selected: CodexReleaseSelection,
  endpoint: string,
  checkedAt: string,
  etag?: string | null,
  responseBodySha256?: string | null,
): CodexReleaseResolution {
  return {
    channel: selected.channel,
    endpoint,
    resolvedTag: selected.tag,
    normalizedVersion: selected.version,
    releaseUrl: selected.releaseUrl,
    checkedAt,
    etag: etag ?? null,
    responseBodySha256: responseBodySha256 ?? null,
  };
}

function assertResolutionResponse(response: GitHubJsonResponse, endpoint: string): void {
  if (response.status === 403 || response.status === 429 || response.rateLimited) {
    throw new Error(`GitHub release resolution rate-limited at ${endpoint}`);
  }
  if (response.status !== 200) throw new Error(`GitHub release resolution failed (${response.status}) at ${endpoint}`);
}

function asRelease(value: unknown): GitHubReleaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub release response");
  return value as GitHubReleaseRecord;
}

function asReleaseList(value: unknown): GitHubReleaseRecord[] {
  if (!Array.isArray(value)) throw new Error("Invalid GitHub releases response");
  return value.map(asRelease);
}

function assertGitIdentity(value: GitObjectIdentity): void {
  if (!/^[a-f0-9]{40,64}$/i.test(value.sha) || (value.type !== "commit" && value.type !== "tag")) {
    throw new Error("Invalid Git object identity while peeling Codex release tag");
  }
}

function skippedDetection(
  channel: CodexSourceChannel,
  endpoint: string,
  checkedAt: string,
  etag: string | null,
  reason: Extract<AdvisoryDetectionResult, { status: "skipped" }>["reason"],
): AdvisoryDetectionResult {
  return { status: "skipped", channel, endpoint, checkedAt, etag, reason };
}

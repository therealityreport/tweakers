import type { TweakManifest } from "@therealityreport/tweakers-sdk";

export const DEFAULT_TWEAK_STORE_INDEX_URL =
  "https://therealityreport.github.io/tweakers/store/index.json";
export const TWEAK_STORE_REVIEW_ISSUE_URL =
  "https://github.com/therealityreport/tweakers/issues/new";

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

export type TweakStoreSource =
  | { kind: "bundled"; path: string }
  | { kind: "remote"; repo: string; approvedCommitSha: string };

/** Canonical project-owned tweak identifiers and source directories. */
export const BUNDLED_TWEAK_SOURCE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "co.tweakers.account-switcher": "tweaks/co.tweakers.account-switcher",
  "co.tweakers.appshots": "tweaks/co.tweakers.appshots",
  "co.tweakers.browser-trust": "tweaks/co.tweakers.browser-trust",
  "co.tweakers.developer-tools": "tweaks/co.tweakers.developer-tools",
  "co.tweakers.shadcn-codex-ui": "tweaks/co.tweakers.shadcn-codex-ui",
  "co.tweakers.followup": "tweaks/followup",
  "co.tweakers.projects": "tweaks/co.tweakers.projects",
  "co.tweakers.thread-summary-profiles": "tweaks/co.tweakers.thread-summary-profiles",
  "co.tweakers.titlebar-controls": "tweaks/titlebar-controls",
  "co.tweakers.ui-improvements": "tweaks/ui-improvements",
  "co.tweakers.user-questions": "tweaks/user-questions",
  "co.tweakers.usage-limit-resets-tracker": "tweaks/usage-limit-resets-tracker",
});

export type TweakHealthStatus = "failed" | "quarantined";

export interface TweakHealthRecord {
  status: TweakHealthStatus;
  updatedAt: string;
  error?: string;
}

/** The user-facing state vocabulary for catalog rows. */
export type TweakStatus =
  | "installed"
  | "not-installed"
  | "enabled"
  | "disabled"
  | "failed"
  | "quarantined";

export interface TweakStatusInput {
  installed: boolean;
  enabled: boolean;
  health?: TweakHealthRecord | null;
}

export function deriveTweakStatus(input: TweakStatusInput): TweakStatus {
  if (!input.installed) return "not-installed";
  if (input.health?.status === "quarantined") return "quarantined";
  if (input.health?.status === "failed") return "failed";
  return input.enabled ? "enabled" : "disabled";
}

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

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FULL_SHA_RE = /^[a-f0-9]{40}$/i;

export function normalizeGitHubRepo(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("GitHub repo is required");

  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(raw);
  if (ssh) return normalizeRepoPart(ssh[1]);

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.hostname !== "github.com") throw new Error("Only github.com repositories are supported");
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) throw new Error("GitHub repo URL must include owner and repository");
    return normalizeRepoPart(`${parts[0]}/${parts[1]}`);
  }

  return normalizeRepoPart(raw);
}

export function normalizeStoreRegistry(input: unknown): TweakStoreRegistry {
  const registry = input as Partial<TweakStoreRegistry> | null;
  if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.entries)) {
    throw new Error("Unsupported tweak store registry");
  }
  const entries = registry.entries.map(normalizeStoreEntry);
  entries.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return {
    schemaVersion: 1,
    generatedAt: typeof registry.generatedAt === "string" ? registry.generatedAt : undefined,
    entries,
  };
}

export function shuffleStoreEntries<T>(
  entries: readonly T[],
  randomIndex: (exclusiveMax: number) => number = (exclusiveMax) => Math.floor(Math.random() * exclusiveMax),
): T[] {
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) {
      throw new Error(`shuffle randomIndex returned ${j}; expected an integer from 0 to ${i}`);
    }
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function normalizeStoreEntry(input: unknown): TweakStoreEntry {
  const entry = input as Partial<TweakStoreEntry> | null;
  if (!entry || typeof entry !== "object") throw new Error("Invalid tweak store entry");
  const manifest = entry.manifest as TweakManifest | undefined;
  const available = entry.available !== false;
  if (!manifest?.id || !manifest.name || !manifest.version || !manifest.githubRepo) {
    throw new Error("Store entry is missing manifest fields");
  }
  const suppliedRepo = typeof entry.repo === "string" && entry.repo.trim()
    ? normalizeGitHubRepo(entry.repo)
    : undefined;
  if (suppliedRepo && normalizeGitHubRepo(manifest.githubRepo) !== suppliedRepo) {
    throw new Error(`Store entry ${manifest.id} repo does not match manifest githubRepo`);
  }
  const sourceInput = (entry as { source?: unknown }).source;
  let source: TweakStoreSource | undefined;
  let repo = suppliedRepo;
  let approvedCommitSha = typeof entry.approvedCommitSha === "string" ? entry.approvedCommitSha : "";
  if (sourceInput !== undefined) {
    if (!sourceInput || typeof sourceInput !== "object" || Array.isArray(sourceInput)) {
      throw new Error(`Store entry ${manifest.id} has an invalid source`);
    }
    const rawSource = sourceInput as { kind?: unknown; path?: unknown; repo?: unknown; approvedCommitSha?: unknown };
    if (rawSource.kind === "bundled") {
      const path = normalizeBundledSourcePath(rawSource.path, manifest.id);
      source = { kind: "bundled", path };
      // A bundled source is intentionally independent of GitHub coordinates.
      repo = suppliedRepo;
      approvedCommitSha = "";
    } else if (rawSource.kind === "remote") {
      const remoteRepo = normalizeGitHubRepo(String(rawSource.repo ?? suppliedRepo ?? ""));
      const sha = String(rawSource.approvedCommitSha ?? entry.approvedCommitSha ?? "");
      if (available && !isFullCommitSha(sha)) {
        throw new Error(`Store entry ${manifest.id} must pin a full approved commit SHA`);
      }
      if (suppliedRepo && suppliedRepo !== remoteRepo) {
        throw new Error(`Store entry ${manifest.id} remote source repo does not match repo`);
      }
      source = { kind: "remote", repo: remoteRepo, approvedCommitSha: sha };
      repo = remoteRepo;
      approvedCommitSha = sha;
    } else {
      throw new Error(`Store entry ${manifest.id} has unsupported source kind`);
    }
  } else if (available) {
    // Legacy available entries are remote and must remain pinned.
    repo = normalizeGitHubRepo(String(repo ?? manifest.githubRepo ?? ""));
    if (!isFullCommitSha(approvedCommitSha)) {
      throw new Error(`Store entry ${manifest.id} must pin a full approved commit SHA`);
    }
    source = { kind: "remote", repo, approvedCommitSha };
  } else if (!repo) {
    // Metadata-only entries may omit all install coordinates. Keep the source
    // absent so callers cannot accidentally treat them as installable.
  }
  return {
    id: manifest.id,
    manifest,
    available,
    ...(repo ? { repo } : {}),
    approvedCommitSha,
    ...(source ? { source } : {}),
    approvedAt: typeof entry.approvedAt === "string" ? entry.approvedAt : "",
    approvedBy: typeof entry.approvedBy === "string" ? entry.approvedBy : "",
    platforms: normalizeStorePlatforms((entry as { platforms?: unknown }).platforms),
    releaseUrl: optionalGithubUrl(entry.releaseUrl),
    reviewUrl: optionalGithubUrl(entry.reviewUrl),
  };
}

export function storeArchiveUrl(entry: TweakStoreEntry): string {
  if (entry.source?.kind === "bundled") {
    throw new Error(`Store entry ${entry.id} uses a bundled source and has no archive URL`);
  }
  const repo = entry.source?.kind === "remote" ? entry.source.repo : entry.repo;
  const approvedCommitSha = entry.source?.kind === "remote"
    ? entry.source.approvedCommitSha
    : entry.approvedCommitSha;
  if (!repo || !isFullCommitSha(approvedCommitSha ?? "")) {
    throw new Error(`Store entry ${entry.id} is not pinned to a full commit SHA`);
  }
  return `https://codeload.github.com/${repo}/tar.gz/${approvedCommitSha}`;
}

export function isBundledStoreEntry(entry: TweakStoreEntry): boolean {
  return entry.source?.kind === "bundled";
}

/** Resolve a packaged source while rejecting traversal and ID mismatches. */
export function resolveBundledTweakPath(
  packagedTweaksRoot: string,
  entry: Pick<TweakStoreEntry, "id" | "source">,
): string {
  if (entry.source?.kind !== "bundled") {
    throw new Error(`Store entry ${entry.id} does not use a bundled source`);
  }
  const normalized = entry.source.path.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === "") ||
    normalized !== BUNDLED_TWEAK_SOURCE_PATHS[entry.id]
  ) {
    throw new Error(`Store entry ${entry.id} has an unsafe bundled source path`);
  }
  // The normalized path is exactly `tweaks/<id>` (no dot segments), so a
  // simple join is sufficient and keeps this shared module browser-bundleable.
  const root = packagedTweaksRoot.replace(/[\\/]+$/, "");
  return `${root}/${normalized}`;
}

function normalizeBundledSourcePath(value: unknown, id: string): string {
  if (typeof value !== "string") throw new Error(`Store entry ${id} bundled source path is required`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized !== BUNDLED_TWEAK_SOURCE_PATHS[id]) {
    throw new Error(`Store entry ${id} bundled source is not allowlisted`);
  }
  return normalized;
}

export function buildTweakPublishIssueUrl(submission: TweakStorePublishSubmission): string {
  const repo = normalizeGitHubRepo(submission.repo);
  if (!isFullCommitSha(submission.commitSha)) {
    throw new Error("Submission must include the full commit SHA to review");
  }
  const title = `Tweak store review: ${repo}`;
  const body = [
    "## Tweak repo",
    `https://github.com/${repo}`,
    "",
    "## Commit to review",
    submission.commitSha,
    submission.commitUrl,
    "",
    "Do not approve a different commit. If the author pushes changes, ask them to resubmit.",
    "",
    "## Manifest",
    `- id: ${submission.manifest?.id ?? "(not detected)"}`,
    `- name: ${submission.manifest?.name ?? "(not detected)"}`,
    `- version: ${submission.manifest?.version ?? "(not detected)"}`,
    `- description: ${submission.manifest?.description ?? "(not detected)"}`,
    `- iconUrl: ${submission.manifest?.iconUrl ?? "(not detected)"}`,
    "",
    "## Admin checklist",
    "- [ ] manifest.json is valid",
    "- [ ] manifest.iconUrl is usable as the store icon",
    "- [ ] source was reviewed at the exact commit above",
    "- [ ] `store/index.json` entry pins `approvedCommitSha` to the exact commit above",
  ].join("\n");
  const url = new URL(TWEAK_STORE_REVIEW_ISSUE_URL);
  url.searchParams.set("template", "tweak-store-review.md");
  url.searchParams.set("title", title);
  url.searchParams.set("body", body);
  return url.toString();
}

export function isFullCommitSha(value: string): boolean {
  return FULL_SHA_RE.test(value);
}

function normalizeRepoPart(value: string): string {
  const repo = value.trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!GITHUB_REPO_RE.test(repo)) throw new Error("GitHub repo must be in owner/repo form");
  return repo;
}

function normalizeStorePlatforms(input: unknown): TweakStorePlatform[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error("Store entry platforms must be an array");
  const allowed = new Set<TweakStorePlatform>(["darwin", "win32", "linux"]);
  const platforms = Array.from(new Set(input.map((value) => {
    if (typeof value !== "string" || !allowed.has(value as TweakStorePlatform)) {
      throw new Error(`Unsupported store platform: ${String(value)}`);
    }
    return value as TweakStorePlatform;
  })));
  return platforms.length > 0 ? platforms : undefined;
}

function optionalGithubUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined;
  return url.toString();
}

import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type { CodexDesktopReleaseProfile, CodexDesktopUpdateTarget } from "./codex-desktop-update-service";

export const OPENAI_DESKTOP_TEAM_IDENTIFIER = "2DC432GLL2" as const;

export interface VerifiedCodexDesktopProfileIdentity {
  schemaVersion: 1;
  profile: CodexDesktopReleaseProfile;
  appPath: string;
  bundleId: "com.openai.codex" | "com.openai.codex.beta";
  version: string | null;
  build: string | null;
  teamIdentifier: typeof OPENAI_DESKTOP_TEAM_IDENTIFIER;
  designatedRequirement: string;
  identityKey: string;
}

export interface CapturedCodexDesktopProfileFeed {
  schemaVersion: 1;
  profile: CodexDesktopReleaseProfile;
  identityKey: string;
  appPath: string;
  bundleId: "com.openai.codex" | "com.openai.codex.beta";
  feedUrl: string;
  fallbackFeedUrl: string | null;
  capturedAt: string;
}

interface EnvironmentSelectionLike {
  selectedDesktopPath?: unknown;
  selectedDesktopBundleId?: unknown;
  releaseProfile?: unknown;
}

interface EnvironmentProfileLike {
  selectedDesktopPath?: unknown;
  selectedDesktopBundleId?: unknown;
  releaseProfile?: unknown;
  officialPath?: unknown;
  officialBundleId?: unknown;
  officialVersion?: unknown;
  officialBuild?: unknown;
  strictSignature?: unknown;
  gatekeeper?: unknown;
  teamIdentifier?: unknown;
  designatedRequirement?: unknown;
  signatureCheckedAt?: unknown;
}

interface EnvironmentRegistryLike {
  schemaVersion?: unknown;
  selected?: EnvironmentSelectionLike | null;
  profiles?: Partial<Record<CodexDesktopReleaseProfile, EnvironmentProfileLike>>;
}

export function verifiedCodexDesktopProfileIdentity(
  registryValue: unknown,
  profile: CodexDesktopReleaseProfile,
): VerifiedCodexDesktopProfileIdentity | null {
  if (!isRecord(registryValue)) return null;
  const registry = registryValue as EnvironmentRegistryLike;
  if (registry.schemaVersion !== 1 || !isRecord(registry.profiles)) return null;
  const candidate = registry.profiles[profile];
  if (!isRecord(candidate)) return null;
  const expectedBundleId = profile === "alpha" ? "com.openai.codex.beta" : "com.openai.codex";
  const appPath = exactAppPath(candidate.officialPath);
  if (
    !appPath
    || candidate.releaseProfile !== profile
    || candidate.selectedDesktopPath !== appPath
    || candidate.officialBundleId !== expectedBundleId
    || candidate.selectedDesktopBundleId !== expectedBundleId
    || candidate.strictSignature !== true
    || candidate.gatekeeper !== true
    || candidate.teamIdentifier !== OPENAI_DESKTOP_TEAM_IDENTIFIER
    || typeof candidate.designatedRequirement !== "string"
    || !candidate.designatedRequirement.trim()
    || typeof candidate.signatureCheckedAt !== "string"
    || !Number.isFinite(Date.parse(candidate.signatureCheckedAt))
  ) return null;

  const version = optionalIdentityString(candidate.officialVersion);
  const build = optionalIdentityString(candidate.officialBuild);
  if (version === undefined || build === undefined) return null;
  const identityMaterial = JSON.stringify([
    profile,
    appPath,
    expectedBundleId,
    version,
    build,
    OPENAI_DESKTOP_TEAM_IDENTIFIER,
    candidate.designatedRequirement,
  ]);
  return {
    schemaVersion: 1,
    profile,
    appPath,
    bundleId: expectedBundleId,
    version,
    build,
    teamIdentifier: OPENAI_DESKTOP_TEAM_IDENTIFIER,
    designatedRequirement: candidate.designatedRequirement,
    identityKey: createHash("sha256").update(identityMaterial).digest("hex"),
  };
}

export function activeVerifiedCodexDesktopProfileIdentity(
  registryValue: unknown,
  selectionValue: unknown,
  activeAppPath: string | null,
): VerifiedCodexDesktopProfileIdentity | null {
  if (!isRecord(selectionValue) || !activeAppPath) return null;
  const selection = selectionValue as EnvironmentSelectionLike;
  const profile = selection.releaseProfile;
  if (profile !== "stable" && profile !== "alpha") return null;
  const identity = verifiedCodexDesktopProfileIdentity(registryValue, profile);
  if (!identity) return null;
  return selection.selectedDesktopPath === identity.appPath
    && selection.selectedDesktopBundleId === identity.bundleId
    && activeAppPath === identity.appPath
    ? identity
    : null;
}

export function createCapturedCodexDesktopProfileFeed(
  identity: VerifiedCodexDesktopProfileIdentity,
  capture: { feedUrl: string | null; fallbackFeedUrl: string | null },
  capturedAt: string,
): CapturedCodexDesktopProfileFeed | null {
  const feedUrl = safePersistedAppcastUrl(capture.feedUrl);
  const fallbackFeedUrl = safePersistedAppcastUrl(capture.fallbackFeedUrl);
  if (!feedUrl || !Number.isFinite(Date.parse(capturedAt))) return null;
  return {
    schemaVersion: 1,
    profile: identity.profile,
    identityKey: identity.identityKey,
    appPath: identity.appPath,
    bundleId: identity.bundleId,
    feedUrl,
    fallbackFeedUrl: fallbackFeedUrl === feedUrl ? null : fallbackFeedUrl,
    capturedAt,
  };
}

export function readCapturedCodexDesktopProfileFeed(
  value: unknown,
  identity: VerifiedCodexDesktopProfileIdentity,
): CapturedCodexDesktopProfileFeed | null {
  if (!isRecord(value)) return null;
  const candidate = value as Partial<CapturedCodexDesktopProfileFeed>;
  const feedUrl = safePersistedAppcastUrl(candidate.feedUrl ?? null);
  const fallbackFeedUrl = safePersistedAppcastUrl(candidate.fallbackFeedUrl ?? null);
  if (
    candidate.schemaVersion !== 1
    || candidate.profile !== identity.profile
    || candidate.identityKey !== identity.identityKey
    || candidate.appPath !== identity.appPath
    || candidate.bundleId !== identity.bundleId
    || !feedUrl
    || typeof candidate.capturedAt !== "string"
    || !Number.isFinite(Date.parse(candidate.capturedAt))
  ) return null;
  return {
    schemaVersion: 1,
    profile: identity.profile,
    identityKey: identity.identityKey,
    appPath: identity.appPath,
    bundleId: identity.bundleId,
    feedUrl,
    fallbackFeedUrl: fallbackFeedUrl === feedUrl ? null : fallbackFeedUrl,
    capturedAt: candidate.capturedAt,
  };
}

export function codexDesktopUpdateTargetForProfile(input: {
  profile: CodexDesktopReleaseProfile;
  identity: VerifiedCodexDesktopProfileIdentity | null;
  capturedFeed: CapturedCodexDesktopProfileFeed | null;
}): CodexDesktopUpdateTarget {
  if (input.profile === "stable") {
    return {
      profile: "stable",
      available: true,
      unavailableReason: null,
      setupRequired: null,
      identityKey: input.identity?.identityKey ?? "official-stable-default",
      feedUrl: null,
      fallbackFeedUrl: null,
    };
  }
  if (!input.identity) {
    return {
      profile: "alpha",
      available: false,
      unavailableReason: "Register a verified OpenAI Beta app in App Mode & Desktop Release before enabling Alpha update checks.",
      setupRequired: "register-beta",
      identityKey: null,
      feedUrl: null,
      fallbackFeedUrl: null,
    };
  }
  if (!input.capturedFeed) {
    return {
      profile: "alpha",
      available: false,
      unavailableReason: "Launch the registered OpenAI Beta app once so Tweakers can capture that app's own Sparkle feed. No Beta feed URL is guessed.",
      setupRequired: "launch-beta",
      identityKey: input.identity.identityKey,
      feedUrl: null,
      fallbackFeedUrl: null,
    };
  }
  return {
    profile: "alpha",
    available: true,
    unavailableReason: null,
    setupRequired: null,
    identityKey: input.identity.identityKey,
    feedUrl: input.capturedFeed.feedUrl,
    fallbackFeedUrl: input.capturedFeed.fallbackFeedUrl,
  };
}

export function safePersistedAppcastUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function exactAppPath(value: unknown): string | null {
  return typeof value === "string"
    && isAbsolute(value)
    && normalize(value) === value
    && /\.app$/i.test(value)
    ? value
    : null;
}

function optionalIdentityString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

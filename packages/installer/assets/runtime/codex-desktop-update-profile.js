"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPENAI_DESKTOP_TEAM_IDENTIFIER = void 0;
exports.verifiedCodexDesktopProfileIdentity = verifiedCodexDesktopProfileIdentity;
exports.activeVerifiedCodexDesktopProfileIdentity = activeVerifiedCodexDesktopProfileIdentity;
exports.createCapturedCodexDesktopProfileFeed = createCapturedCodexDesktopProfileFeed;
exports.readCapturedCodexDesktopProfileFeed = readCapturedCodexDesktopProfileFeed;
exports.codexDesktopUpdateTargetForProfile = codexDesktopUpdateTargetForProfile;
exports.safePersistedAppcastUrl = safePersistedAppcastUrl;
const node_crypto_1 = require("node:crypto");
const node_path_1 = require("node:path");
exports.OPENAI_DESKTOP_TEAM_IDENTIFIER = "2DC432GLL2";
function verifiedCodexDesktopProfileIdentity(registryValue, profile) {
    if (!isRecord(registryValue))
        return null;
    const registry = registryValue;
    if (registry.schemaVersion !== 1 || !isRecord(registry.profiles))
        return null;
    const candidate = registry.profiles[profile];
    if (!isRecord(candidate))
        return null;
    const expectedBundleId = profile === "alpha" ? "com.openai.codex.beta" : "com.openai.codex";
    const appPath = exactAppPath(candidate.officialPath);
    if (!appPath
        || candidate.releaseProfile !== profile
        || candidate.selectedDesktopPath !== appPath
        || candidate.officialBundleId !== expectedBundleId
        || candidate.selectedDesktopBundleId !== expectedBundleId
        || candidate.strictSignature !== true
        || candidate.gatekeeper !== true
        || candidate.teamIdentifier !== exports.OPENAI_DESKTOP_TEAM_IDENTIFIER
        || typeof candidate.designatedRequirement !== "string"
        || !candidate.designatedRequirement.trim()
        || typeof candidate.signatureCheckedAt !== "string"
        || !Number.isFinite(Date.parse(candidate.signatureCheckedAt)))
        return null;
    const version = optionalIdentityString(candidate.officialVersion);
    const build = optionalIdentityString(candidate.officialBuild);
    if (version === undefined || build === undefined)
        return null;
    const identityMaterial = JSON.stringify([
        profile,
        appPath,
        expectedBundleId,
        version,
        build,
        exports.OPENAI_DESKTOP_TEAM_IDENTIFIER,
        candidate.designatedRequirement,
    ]);
    return {
        schemaVersion: 1,
        profile,
        appPath,
        bundleId: expectedBundleId,
        version,
        build,
        teamIdentifier: exports.OPENAI_DESKTOP_TEAM_IDENTIFIER,
        designatedRequirement: candidate.designatedRequirement,
        identityKey: (0, node_crypto_1.createHash)("sha256").update(identityMaterial).digest("hex"),
    };
}
function activeVerifiedCodexDesktopProfileIdentity(registryValue, selectionValue, activeAppPath) {
    if (!isRecord(selectionValue) || !activeAppPath)
        return null;
    const selection = selectionValue;
    const profile = selection.releaseProfile;
    if (profile !== "stable" && profile !== "alpha")
        return null;
    const identity = verifiedCodexDesktopProfileIdentity(registryValue, profile);
    if (!identity)
        return null;
    return selection.selectedDesktopPath === identity.appPath
        && selection.selectedDesktopBundleId === identity.bundleId
        && activeAppPath === identity.appPath
        ? identity
        : null;
}
function createCapturedCodexDesktopProfileFeed(identity, capture, capturedAt) {
    const feedUrl = safePersistedAppcastUrl(capture.feedUrl);
    const fallbackFeedUrl = safePersistedAppcastUrl(capture.fallbackFeedUrl);
    if (!feedUrl || !Number.isFinite(Date.parse(capturedAt)))
        return null;
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
function readCapturedCodexDesktopProfileFeed(value, identity) {
    if (!isRecord(value))
        return null;
    const candidate = value;
    const feedUrl = safePersistedAppcastUrl(candidate.feedUrl ?? null);
    const fallbackFeedUrl = safePersistedAppcastUrl(candidate.fallbackFeedUrl ?? null);
    if (candidate.schemaVersion !== 1
        || candidate.profile !== identity.profile
        || candidate.identityKey !== identity.identityKey
        || candidate.appPath !== identity.appPath
        || candidate.bundleId !== identity.bundleId
        || !feedUrl
        || typeof candidate.capturedAt !== "string"
        || !Number.isFinite(Date.parse(candidate.capturedAt)))
        return null;
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
function codexDesktopUpdateTargetForProfile(input) {
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
function safePersistedAppcastUrl(value) {
    if (typeof value !== "string")
        return null;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:")
            return null;
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
    }
    catch {
        return null;
    }
}
function exactAppPath(value) {
    return typeof value === "string"
        && (0, node_path_1.isAbsolute)(value)
        && (0, node_path_1.normalize)(value) === value
        && /\.app$/i.test(value)
        ? value
        : null;
}
function optionalIdentityString(value) {
    if (value === null)
        return null;
    return typeof value === "string" && value.trim() ? value : undefined;
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=codex-desktop-update-profile.js.map
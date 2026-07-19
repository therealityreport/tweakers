import type { CodexDesktopReleaseProfile, CodexDesktopUpdateTarget } from "./codex-desktop-update-service";
export declare const OPENAI_DESKTOP_TEAM_IDENTIFIER: "2DC432GLL2";
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
export declare function verifiedCodexDesktopProfileIdentity(registryValue: unknown, profile: CodexDesktopReleaseProfile): VerifiedCodexDesktopProfileIdentity | null;
export declare function activeVerifiedCodexDesktopProfileIdentity(registryValue: unknown, selectionValue: unknown, activeAppPath: string | null): VerifiedCodexDesktopProfileIdentity | null;
export declare function createCapturedCodexDesktopProfileFeed(identity: VerifiedCodexDesktopProfileIdentity, capture: {
    feedUrl: string | null;
    fallbackFeedUrl: string | null;
}, capturedAt: string): CapturedCodexDesktopProfileFeed | null;
export declare function readCapturedCodexDesktopProfileFeed(value: unknown, identity: VerifiedCodexDesktopProfileIdentity): CapturedCodexDesktopProfileFeed | null;
export declare function codexDesktopUpdateTargetForProfile(input: {
    profile: CodexDesktopReleaseProfile;
    identity: VerifiedCodexDesktopProfileIdentity | null;
    capturedFeed: CapturedCodexDesktopProfileFeed | null;
}): CodexDesktopUpdateTarget;
export declare function safePersistedAppcastUrl(value: unknown): string | null;

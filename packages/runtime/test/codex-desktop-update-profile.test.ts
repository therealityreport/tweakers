import assert from "node:assert/strict";
import test from "node:test";
import {
  activeVerifiedCodexDesktopProfileIdentity,
  codexDesktopUpdateTargetForProfile,
  createCapturedCodexDesktopProfileFeed,
  readCapturedCodexDesktopProfileFeed,
  verifiedCodexDesktopProfileIdentity,
} from "../src/codex-desktop-update-profile";

const stablePath = "/Applications/ChatGPT.app";
const alphaPath = "/Applications/ChatGPT (Beta).app";

function registry() {
  return {
    schemaVersion: 1,
    selected: {
      selectedDesktopPath: alphaPath,
      selectedDesktopBundleId: "com.openai.codex.beta",
      releaseProfile: "alpha",
    },
    profiles: {
      stable: profile("stable", stablePath, "com.openai.codex", "1.2.3", "123"),
      alpha: profile("alpha", alphaPath, "com.openai.codex.beta", "1.3.0-beta", "130"),
    },
  };
}

function profile(
  releaseProfile: "stable" | "alpha",
  path: string,
  bundleId: "com.openai.codex" | "com.openai.codex.beta",
  version: string,
  build: string,
) {
  return {
    selectedDesktopPath: path,
    selectedDesktopBundleId: bundleId,
    releaseProfile,
    officialPath: path,
    officialBundleId: bundleId,
    officialVersion: version,
    officialBuild: build,
    strictSignature: true,
    gatekeeper: true,
    teamIdentifier: "2DC432GLL2",
    designatedRequirement: `identifier ${bundleId} and certificate leaf[subject.OU] = 2DC432GLL2`,
    signatureCheckedAt: "2026-07-17T12:00:00.000Z",
  };
}

test("Alpha target requires a registered verified OpenAI Beta identity", () => {
  const verified = verifiedCodexDesktopProfileIdentity(registry(), "alpha");
  assert.ok(verified);
  assert.equal(verified.bundleId, "com.openai.codex.beta");

  const unverifiedRegistry = registry();
  unverifiedRegistry.profiles.alpha.teamIdentifier = "UNTRUSTED";
  assert.equal(verifiedCodexDesktopProfileIdentity(unverifiedRegistry, "alpha"), null);
  assert.deepEqual(codexDesktopUpdateTargetForProfile({
    profile: "alpha",
    identity: null,
    capturedFeed: null,
  }), {
    profile: "alpha",
    available: false,
    unavailableReason: "Register a verified OpenAI Beta app in App Mode & Desktop Release before enabling Alpha update checks.",
    setupRequired: "register-beta",
    identityKey: null,
    feedUrl: null,
    fallbackFeedUrl: null,
  });
});

test("a verified Alpha app remains gated until its own capture exists", () => {
  const identity = verifiedCodexDesktopProfileIdentity(registry(), "alpha");
  assert.ok(identity);
  const target = codexDesktopUpdateTargetForProfile({ profile: "alpha", identity, capturedFeed: null });
  assert.equal(target.available, false);
  assert.equal(target.setupRequired, "launch-beta");
  assert.match(target.unavailableReason ?? "", /No Beta feed URL is guessed/);
});

test("capture persistence strips secrets and reloads only for the exact identity", () => {
  const identity = verifiedCodexDesktopProfileIdentity(registry(), "alpha");
  assert.ok(identity);
  const capture = createCapturedCodexDesktopProfileFeed(identity, {
    feedUrl: "https://beta.example.test/appcast.xml?token=secret#fragment",
    fallbackFeedUrl: "https://beta.example.test/public.xml?tracking=1",
  }, "2026-07-17T13:00:00.000Z");
  assert.ok(capture);
  assert.equal(capture.feedUrl, "https://beta.example.test/appcast.xml");
  assert.equal(capture.fallbackFeedUrl, "https://beta.example.test/public.xml");
  assert.doesNotMatch(JSON.stringify(capture), /secret|token|tracking/);
  assert.deepEqual(readCapturedCodexDesktopProfileFeed(capture, identity), capture);

  const changedRegistry = registry();
  changedRegistry.profiles.alpha.officialBuild = "131";
  const changedIdentity = verifiedCodexDesktopProfileIdentity(changedRegistry, "alpha");
  assert.ok(changedIdentity);
  assert.notEqual(changedIdentity.identityKey, identity.identityKey);
  assert.equal(readCapturedCodexDesktopProfileFeed(capture, changedIdentity), null);
});

test("active capture binding rejects another path or profile", () => {
  const value = registry();
  const selected = value.selected;
  assert.equal(activeVerifiedCodexDesktopProfileIdentity(value, selected, alphaPath)?.profile, "alpha");
  assert.equal(activeVerifiedCodexDesktopProfileIdentity(value, selected, stablePath), null);
  assert.equal(activeVerifiedCodexDesktopProfileIdentity(value, {
    ...selected,
    releaseProfile: "stable",
  }, alphaPath), null);
});

test("Stable stays available without a captured feed and cannot inherit Alpha state", () => {
  const alphaIdentity = verifiedCodexDesktopProfileIdentity(registry(), "alpha");
  assert.ok(alphaIdentity);
  const alphaFeed = createCapturedCodexDesktopProfileFeed(alphaIdentity, {
    feedUrl: "https://beta.example.test/appcast.xml",
    fallbackFeedUrl: null,
  }, "2026-07-17T13:00:00.000Z");
  assert.ok(alphaFeed);

  const stable = codexDesktopUpdateTargetForProfile({
    profile: "stable",
    identity: null,
    capturedFeed: alphaFeed,
  });
  assert.equal(stable.available, true);
  assert.equal(stable.setupRequired, null);
  assert.equal(stable.feedUrl, null);
  assert.equal(stable.identityKey, "official-stable-default");
});

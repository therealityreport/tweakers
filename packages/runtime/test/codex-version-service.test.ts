import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildCodexFeatureUnion,
  codexHeading,
  codexVersionChannel,
  compareCodexVersions,
  computeCodexUpdateAvailable,
  createCodexVersionService,
  filterCodexReleases,
  isCodexDesktopUpdateNewer,
  parseCodexCliVersion,
  probeCodexDesktopVersion,
  parseCodexFeatureList,
  parseCodexVersionTag,
  resolveCodexReleaseAsset,
  selectLatestCodexRelease,
} from "../src/codex-version-service.js";
import type {
  CodexReleaseCacheEntry,
  GitHubCodexRelease,
} from "../src/codex-version-types.js";

const fixtureDirectory = path.join(process.cwd(), "packages/runtime/test/fixtures/codex-versions");

function release(
  tag: string,
  options: Partial<GitHubCodexRelease> = {},
): GitHubCodexRelease {
  const assetName = "codex-package-aarch64-apple-darwin.tar.gz";
  return {
    tag_name: tag,
    draft: false,
    prerelease: tag.includes("-alpha."),
    published_at: "2026-07-13T12:00:00Z",
    html_url: `https://github.com/openai/codex/releases/tag/${tag}`,
    assets: [{
      name: assetName,
      browser_download_url: `https://github.com/openai/codex/releases/download/${tag}/${assetName}`,
      digest: `sha256:${"ab".repeat(32)}`,
    }],
    ...options,
  };
}

test("Codex tags parse exactly and stable sorts above alphas of the same version", () => {
  const alpha2 = parseCodexVersionTag("rust-v0.144.0-alpha.2");
  const alpha10 = parseCodexVersionTag("rust-v0.144.0-alpha.10");
  const stable = parseCodexVersionTag("rust-v0.144.0");

  assert.deepEqual(alpha2, {
    major: 0n,
    minor: 144n,
    patch: 0n,
    prerelease: 2n,
    version: "0.144.0-alpha.2",
    tag: "rust-v0.144.0-alpha.2",
  });
  assert.equal(compareCodexVersions(alpha10!, alpha2!), 1);
  assert.equal(compareCodexVersions(stable!, alpha10!), 1);
  assert.equal(parseCodexVersionTag("v0.144.0"), null);
  assert.equal(parseCodexVersionTag("rust-v0.144.0-beta.1"), null);
  assert.equal(parseCodexVersionTag("rust-v01.144.0"), null);
  assert.equal(
    compareCodexVersions(
      parseCodexVersionTag("rust-v9007199254740993.0.0")!,
      parseCodexVersionTag("rust-v9007199254740992.0.0")!,
    ),
    1,
  );
  assert.equal(
    compareCodexVersions(
      parseCodexVersionTag("rust-v0.144.0-alpha.9007199254740993")!,
      parseCodexVersionTag("rust-v0.144.0-alpha.9007199254740992")!,
    ),
    1,
  );
});

test("installed CLI channel is measured from the version, not its source lane", () => {
  assert.equal(codexVersionChannel("0.144.5"), "stable");
  assert.equal(codexVersionChannel("0.145.0-alpha.18"), "prerelease");
  assert.equal(codexVersionChannel("0.145.0-beta.1"), "unknown");
  assert.equal(codexVersionChannel(null), "unknown");
});

test("desktop probing prefers live app marketing version and falls back through plist and state", () => {
  assert.deepEqual(probeCodexDesktopVersion({
    appVersion: " 1.2026.190 ",
    infoPlistMarketingVersion: "1.2026.180",
    infoPlistBuild: " 2026071301 ",
    stateMarketingVersion: "1.2026.170",
    stateBuild: "2026071201",
  }), {
    installedMarketingVersion: "1.2026.190",
    installedBuild: "2026071301",
  });
  assert.deepEqual(probeCodexDesktopVersion({
    appVersion: "",
    infoPlistMarketingVersion: "1.2026.180",
    infoPlistBuild: null,
    stateMarketingVersion: "1.2026.170",
    stateBuild: "2026071201",
  }), {
    installedMarketingVersion: "1.2026.180",
    installedBuild: "2026071201",
  });
  assert.deepEqual(probeCodexDesktopVersion({}), {
    installedMarketingVersion: null,
    installedBuild: null,
  });
});

test("desktop update comparison prefers Sparkle builds and safely falls back to dotted versions", () => {
  assert.equal(isCodexDesktopUpdateNewer("26.707.51957", "5175", "26.707.62119", "5211"), true);
  assert.equal(isCodexDesktopUpdateNewer("26.707.62119", "5211", "26.707.62119", "5211"), false);
  assert.equal(isCodexDesktopUpdateNewer("26.707.62119", "5211", "99.0.0", "5200"), false);
  assert.equal(isCodexDesktopUpdateNewer("26.707.51957", null, "26.707.62119", null), true);
  assert.equal(isCodexDesktopUpdateNewer("invalid", null, "26.707.62119", null), false);
  assert.equal(isCodexDesktopUpdateNewer(null, null, "26.707.62119", "5211"), false);
  assert.equal(isCodexDesktopUpdateNewer("9007199254740992", null, "9007199254740993", null), true);
});

test("release filters keep only semver releases belonging to the requested lane", () => {
  const releases = [
    release("rust-v0.144.2"),
    release("rust-v0.144.3"),
    release("rust-v0.145.0-alpha.2"),
    release("rust-v0.145.0-alpha.10"),
    release("rust-v0.145.0-alpha.18"),
    release("rust-v0.145.0-alpha.22"),
    release("rust-v0.1.2025-beta", { prerelease: true }),
    release("rust-v9.0.0", { draft: true }),
    release("rust-v8.0.0", { prerelease: true }),
  ];

  assert.deepEqual(
    filterCodexReleases(releases, "bundled").map((item) => item.tag_name),
    ["rust-v0.144.2", "rust-v0.144.3"],
  );
  assert.deepEqual(
    filterCodexReleases(releases, "beta").map((item) => item.tag_name),
    [
      "rust-v0.145.0-alpha.2",
      "rust-v0.145.0-alpha.10",
      "rust-v0.145.0-alpha.18",
      "rust-v0.145.0-alpha.22",
    ],
  );
  assert.equal(selectLatestCodexRelease(releases, "bundled")?.tag_name, "rust-v0.144.3");
  assert.equal(selectLatestCodexRelease(releases, "beta")?.tag_name, "rust-v0.145.0-alpha.22");
});

test("asset resolution accepts one allowlisted arm64 mac package with a SHA-256 digest", () => {
  const asset = {
    name: "codex-package-aarch64-apple-darwin.tar.gz",
    browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.145.0-alpha.7/codex-package-aarch64-apple-darwin.tar.gz",
    digest: `sha256:${"ab".repeat(32)}`,
  };
  assert.deepEqual(resolveCodexReleaseAsset(release("rust-v0.145.0-alpha.7", { assets: [asset] })), {
    name: asset.name,
    url: asset.browser_download_url,
    digest: "ab".repeat(32),
  });

  assert.throws(
    () => resolveCodexReleaseAsset(release("rust-v0.145.0-alpha.7", { assets: [] })),
    /missing allowlisted darwin-arm64 asset/,
  );
  assert.throws(
    () => resolveCodexReleaseAsset(release("rust-v0.145.0-alpha.7", { assets: [asset, asset] })),
    /duplicate allowlisted darwin-arm64 asset/,
  );
  assert.throws(
    () => resolveCodexReleaseAsset(release("rust-v0.145.0-alpha.7", { assets: [{ ...asset, digest: null }] })),
    /missing or invalid SHA-256 digest/,
  );
});

test("feature fixtures parse all stages and build selected-lane differences", async () => {
  const [bundledText, betaText] = await Promise.all([
    readFile(path.join(fixtureDirectory, "bundled-features.txt"), "utf8"),
    readFile(path.join(fixtureDirectory, "beta-features.txt"), "utf8"),
  ]);
  const bundled = parseCodexFeatureList(bundledText);
  const beta = parseCodexFeatureList(betaText);
  assert.deepEqual(
    [...new Set(bundled.map((entry) => entry.stage))].sort(),
    ["deprecated", "experimental", "removed", "stable", "under-development"],
  );

  const union = buildCodexFeatureUnion(bundled, beta, "beta");
  assert.ok(union.length > 50);
  assert.deepEqual(
    union.map((entry) => entry.name),
    union.map((entry) => entry.name).sort(),
  );
  assert.deepEqual(union.find((entry) => entry.name === "imagegenext"), {
    name: "imagegenext",
    stages: { bundled: null, beta: "under-development" },
    enabled: { bundled: null, beta: false },
    selectedLane: "beta",
    selectedStage: "under-development",
    selectedEnabled: false,
    bundledOnly: false,
    betaOnly: true,
    mutable: true,
    supported: true,
    effect: "new-session",
  });
  assert.equal(union.find((entry) => entry.name === "use_legacy_landlock")?.mutable, false);
  assert.equal(union.find((entry) => entry.name === "apply_patch_freeform")?.effect, "none");
});

test("feature parsing rejects duplicate names and every malformed non-empty line", () => {
  assert.throws(
    () => parseCodexFeatureList("apps stable true\napps stable false\n"),
    /duplicate feature: apps/,
  );
  assert.throws(() => parseCodexFeatureList("apps unknown true\n"), /malformed feature line 1/);
  assert.throws(() => parseCodexFeatureList("apps stable yes\n"), /malformed feature line 1/);
  assert.throws(() => parseCodexFeatureList("apps stable true trailing\n"), /malformed feature line 1/);
});

test("CLI probing parses exact version output and reports a missing binary safely", async () => {
  assert.equal(parseCodexCliVersion("codex-cli 0.144.0-alpha.2\n"), "0.144.0-alpha.2");
  assert.equal(parseCodexCliVersion("codex 0.144.0"), null);

  const service = createCodexVersionService({
    currentVersion: "1.0.0",
    now: () => Date.parse("2026-07-13T12:00:00Z"),
    readReleaseCache: async () => null,
    writeReleaseCache: async () => undefined,
    fetchReleases: async () => [],
    execFile: async () => {
      const error = new Error("spawn ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.deepEqual(await service.probeCli("/missing/codex"), {
    path: "/missing/codex",
    available: false,
    version: null,
    features: null,
    error: "Codex CLI is not installed at the expected path.",
  });
});

test("CLI probing runs the bounded version and feature commands and returns parsed inventory", async () => {
  const calls: Array<{ binary: string; args: readonly string[]; timeoutMs: number; maxOutputBytes: number }> = [];
  const service = createCodexVersionService({
    currentVersion: "1.0.0",
    now: () => Date.parse("2026-07-13T12:00:00Z"),
    readReleaseCache: async () => null,
    writeReleaseCache: async () => undefined,
    fetchReleases: async () => [],
    execFile: async (binary, args, options) => {
      calls.push({ binary, args, ...options });
      return { stdout: args[0] === "--version" ? "codex-cli 0.144.1\n" : "apps stable true\n" };
    },
  });
  assert.deepEqual(await service.probeCli("/opt/codex"), {
    path: "/opt/codex",
    available: true,
    version: "0.144.1",
    features: [{ name: "apps", stage: "stable", enabled: true }],
    error: null,
  });
  assert.deepEqual(calls, [
    { binary: "/opt/codex", args: ["--version"], timeoutMs: 5_000, maxOutputBytes: 512 * 1_024 },
    { binary: "/opt/codex", args: ["features", "list"], timeoutMs: 5_000, maxOutputBytes: 512 * 1_024 },
  ]);
});

test("CLI probing marks a malformed feature inventory unavailable", async () => {
  const service = createCodexVersionService({
    currentVersion: "1.0.0",
    now: () => Date.parse("2026-07-13T12:00:00Z"),
    readReleaseCache: async () => null,
    writeReleaseCache: async () => undefined,
    fetchReleases: async () => [],
    execFile: async (_binary, args) => ({
      stdout: args[0] === "--version" ? "codex-cli 0.144.1\n" : "apps future maybe\n",
    }),
  });
  const result = await service.probeCli("/opt/codex");
  assert.equal(result.available, false);
  assert.match(result.error ?? "", /malformed feature line 1/);
});

test("heading changes only when an actionable Codex update exists", () => {
  assert.equal(computeCodexUpdateAvailable({
    desktopActionable: false,
    desktopUpdateAvailable: true,
    bundledCliUpdateAvailable: false,
    betaCliUpdateAvailable: false,
  }), false);
  assert.equal(computeCodexUpdateAvailable({
    desktopActionable: false,
    desktopUpdateAvailable: false,
    bundledCliUpdateAvailable: false,
    betaCliUpdateAvailable: true,
  }), true);
  assert.equal(codexHeading(false), "CODEX");
  assert.equal(codexHeading(true), "CODEX (UPDATE AVAILABLE)");
});

test("selected features are read-only when their inventory is not fresh", () => {
  const features = parseCodexFeatureList("apps stable true\n");
  const union = buildCodexFeatureUnion(features, features, "beta", {
    bundled: true,
    beta: false,
  });
  assert.equal(union[0]?.supported, true);
  assert.equal(union[0]?.mutable, false);
  assert.equal(union[0]?.effect, "none");
});

test("release service uses a matching one-hour cache and refreshes after expiry", async () => {
  let now = Date.parse("2026-07-13T12:00:00Z");
  let fetchCount = 0;
  let writtenLane: string | null = null;
  const cachedRelease = release("rust-v0.144.3");
  const cache: CodexReleaseCacheEntry = {
    schemaVersion: 1,
    currentVersion: "1.0.0",
    lane: "bundled",
    checkedAt: new Date(now - 59 * 60 * 1000).toISOString(),
    release: cachedRelease,
  };
  const service = createCodexVersionService({
    currentVersion: "1.0.0",
    now: () => now,
    readReleaseCache: async () => cache,
    writeReleaseCache: async (_lane, value) => { writtenLane = value.lane; },
    fetchReleases: async () => {
      fetchCount += 1;
      return [release("rust-v0.144.4")];
    },
    execFile: async () => ({ stdout: "" }),
  });

  const fresh = await service.fetchLatestRelease("bundled");
  assert.equal(fresh.release?.tag, "rust-v0.144.3");
  assert.equal(fresh.fromCache, true);
  assert.equal(fresh.stale, false);
  assert.equal(fetchCount, 0);

  now += 2 * 60 * 1000;
  const refreshed = await service.fetchLatestRelease("bundled");
  assert.equal(refreshed.release?.tag, "rust-v0.144.4");
  assert.equal(refreshed.fromCache, false);
  assert.equal(fetchCount, 1);
  assert.equal(writtenLane, "bundled");
});

test("timeout returns matching stale cache with a lane-specific error and never erases it", async () => {
  const now = Date.parse("2026-07-13T12:00:00Z");
  let writeCount = 0;
  const cache: CodexReleaseCacheEntry = {
    schemaVersion: 1,
    currentVersion: "1.0.0",
    lane: "beta",
    checkedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    release: release("rust-v0.145.0-alpha.7"),
  };
  const service = createCodexVersionService({
    currentVersion: "1.0.0",
    now: () => now,
    timeoutMs: 5,
    readReleaseCache: async () => cache,
    writeReleaseCache: async () => { writeCount += 1; },
    fetchReleases: async () => new Promise<never>(() => undefined),
    execFile: async () => ({ stdout: "" }),
  });

  const result = await service.fetchLatestRelease("beta");
  assert.equal(result.release?.tag, "rust-v0.145.0-alpha.7");
  assert.equal(result.fromCache, true);
  assert.equal(result.stale, true);
  assert.match(result.error ?? "", /^beta: release check timed out/);
  assert.equal(writeCount, 0);
});

test("cache keys reject mismatched schema, runtime version, or lane", async () => {
  const now = Date.parse("2026-07-13T12:00:00Z");
  for (const mismatch of [
    { schemaVersion: 2 },
    { currentVersion: "0.9.0" },
    { lane: "beta" },
  ] as const) {
    let fetched = false;
    const service = createCodexVersionService({
      currentVersion: "1.0.0",
      now: () => now,
      readReleaseCache: async () => ({
        schemaVersion: 1,
        currentVersion: "1.0.0",
        lane: "bundled",
        checkedAt: new Date(now).toISOString(),
        release: release("rust-v0.144.3"),
        ...mismatch,
      }),
      writeReleaseCache: async () => undefined,
      fetchReleases: async () => {
        fetched = true;
        return [release("rust-v0.144.4")];
      },
      execFile: async () => ({ stdout: "" }),
    });
    const result = await service.fetchLatestRelease("bundled");
    assert.equal(fetched, true);
    assert.equal(result.release?.tag, "rust-v0.144.4");
  }
});

test("cache validation rejects drafts and releases from the wrong channel", async () => {
  const now = Date.parse("2026-07-13T12:00:00Z");
  for (const cachedRelease of [
    release("rust-v0.145.0-alpha.7"),
    release("rust-v0.144.3", { draft: true }),
    release("rust-v0.144.3", { prerelease: true }),
  ]) {
    let fetched = false;
    const service = createCodexVersionService({
      currentVersion: "1.0.0",
      now: () => now,
      readReleaseCache: async () => ({
        schemaVersion: 1,
        currentVersion: "1.0.0",
        lane: "bundled",
        checkedAt: new Date(now).toISOString(),
        release: cachedRelease,
      }),
      writeReleaseCache: async () => undefined,
      fetchReleases: async () => {
        fetched = true;
        return [release("rust-v0.144.4")];
      },
      execFile: async () => ({ stdout: "" }),
    });
    const result = await service.fetchLatestRelease("bundled");
    assert.equal(fetched, true);
    assert.equal(result.release?.tag, "rust-v0.144.4");
  }
});

test("malformed cache payloads are ignored without throwing", async () => {
  let fetched = false;
  const service = createCodexVersionService({
    currentVersion: "1.0.0",
    now: () => Date.parse("2026-07-13T12:00:00Z"),
    readReleaseCache: async () => ({
      schemaVersion: 1,
      currentVersion: "1.0.0",
      lane: "bundled",
      checkedAt: "2026-07-13T12:00:00Z",
      release: { tag_name: "rust-v0.144.3" },
    }),
    writeReleaseCache: async () => undefined,
    fetchReleases: async () => {
      fetched = true;
      return [release("rust-v0.144.4")];
    },
    execFile: async () => ({ stdout: "" }),
  });
  const result = await service.fetchLatestRelease("bundled");
  assert.equal(fetched, true);
  assert.equal(result.release?.tag, "rust-v0.144.4");
});

test("an unreadable cache does not block a live release refresh", async () => {
  const service = createCodexVersionService({
    currentVersion: "1.0.0",
    now: () => Date.parse("2026-07-13T12:00:00Z"),
    readReleaseCache: async () => { throw new Error("EACCES"); },
    writeReleaseCache: async () => undefined,
    fetchReleases: async () => [release("rust-v0.144.4")],
    execFile: async () => ({ stdout: "" }),
  });
  const result = await service.fetchLatestRelease("bundled");
  assert.equal(result.release?.tag, "rust-v0.144.4");
  assert.equal(result.fromCache, false);
});

test("a cache write failure does not discard successfully fetched metadata", async () => {
  const service = createCodexVersionService({
    currentVersion: "1.0.0",
    now: () => Date.parse("2026-07-13T12:00:00Z"),
    readReleaseCache: async () => null,
    writeReleaseCache: async () => { throw new Error("disk full"); },
    fetchReleases: async () => [release("rust-v0.144.4")],
    execFile: async () => ({ stdout: "" }),
  });
  const result = await service.fetchLatestRelease("bundled");
  assert.equal(result.release?.tag, "rust-v0.144.4");
  assert.equal(result.fromCache, false);
  assert.equal(result.stale, false);
  assert.match(result.error ?? "", /^bundled: could not cache release metadata/);
});

test("invalid live asset metadata never replaces last-known-good cache", async () => {
  const now = Date.parse("2026-07-13T12:00:00Z");
  let writes = 0;
  const service = createCodexVersionService({
    currentVersion: "1.0.0",
    now: () => now,
    readReleaseCache: async () => ({
      schemaVersion: 1,
      currentVersion: "1.0.0",
      lane: "beta",
      checkedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
      release: release("rust-v0.145.0-alpha.7"),
    }),
    writeReleaseCache: async () => { writes += 1; },
    fetchReleases: async () => [release("rust-v0.145.0-alpha.8", { assets: [] })],
    execFile: async () => ({ stdout: "" }),
  });
  const result = await service.fetchLatestRelease("beta");
  assert.equal(result.release?.tag, "rust-v0.145.0-alpha.7");
  assert.equal(result.stale, true);
  assert.match(result.error ?? "", /missing allowlisted darwin-arm64 asset/);
  assert.equal(writes, 0);
});

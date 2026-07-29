import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_RELEASE_API_ROOT,
  assertChannelPromotionAllowed,
  assertNpmDoesNotLead,
  assertTagIdentityStable,
  compareSemverPrecedence,
  detectCodexReleaseAdvisory,
  evaluateNpmAgreement,
  parseCodexReleaseTag,
  parseSemver,
  peelCodexTag,
  resolveCodexSourceRelease,
  selectBundledRelease,
  selectEdgeRelease,
  selectStableRelease,
  type GitHubJsonRequest,
} from "../src/codex-source-release.ts";

const published = "2026-07-19T12:00:00.000Z";
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);

test("strict rust-v parsing and SemVer precedence reject loose tags and sort numeric prereleases", () => {
  assert.equal(parseCodexReleaseTag("rust-v0.144.6")?.normalized, "0.144.6");
  assert.equal(parseCodexReleaseTag("v0.144.6"), null);
  assert.equal(parseCodexReleaseTag("rust-v0.145.0-alpha.01"), null);
  assert.equal(parseSemver("01.2.3"), null);
  assert.equal(compareSemverPrecedence("0.145.0-alpha.9", "0.145.0-alpha.18"), -1);
  assert.equal(compareSemverPrecedence("0.145.0-alpha.18", "0.144.6"), 1);
  assert.equal(compareSemverPrecedence("1.0.0+one", "1.0.0+two"), 0);
});

test("stable selection requires both GitHub stable flags and a version-string stable backstop", () => {
  assert.deepEqual(selectStableRelease({
    tag_name: "rust-v0.144.6",
    draft: false,
    prerelease: false,
    published_at: published,
    html_url: "https://example.test/stable",
  }), {
    channel: "stable",
    tag: "rust-v0.144.6",
    version: "0.144.6",
    prerelease: false,
    releaseUrl: "https://example.test/stable",
  });
  assert.throws(() => selectStableRelease({
    tag_name: "rust-v0.145.0-alpha.18",
    draft: false,
    prerelease: false,
    published_at: published,
  }), /not a published, non-prerelease/);
  assert.throws(() => selectStableRelease({
    tag_name: "rust-v0.144.6",
    draft: false,
    prerelease: true,
    published_at: published,
  }), /not a published, non-prerelease/);
});

test("bundled selection resolves the installed frontend backend exactly, including prereleases", () => {
  assert.equal(selectBundledRelease(
    release("rust-v0.145.0-alpha.18", true),
    "0.145.0-alpha.18",
  ).channel, "bundled");
  assert.throws(() => selectBundledRelease(
    release("rust-v0.145.0-alpha.24", true),
    "0.145.0-alpha.18",
  ), /exact bundled Codex tag/);
  assert.equal(selectBundledRelease(
    release("rust-v0.145.0-alpha.18", false),
    "0.145.0-alpha.18",
  ).version, "0.145.0-alpha.18");
});

test("edge selection includes stable releases and uses full SemVer precedence", () => {
  const selected = selectEdgeRelease([
    release("rust-v0.145.0-alpha.9", true),
    release("rust-v0.144.6", false),
    release("rust-v0.145.0-alpha.18", true),
    { ...release("rust-v99.0.0-alpha.1", true), draft: true },
  ]);
  assert.equal(selected.version, "0.145.0-alpha.18");
  assert.equal(selected.channel, "edge");
});

test("daily stable advisory uses one conditional request and honors 304", async () => {
  const requests: GitHubJsonRequest[] = [];
  const result = await detectCodexReleaseAdvisory({
    channel: "stable",
    cache: { etag: "etag-one", lastKnownVersion: "0.144.6" },
    now: () => published,
    fetchJson: async (request) => {
      requests.push(request);
      return { status: 304, etag: "etag-one" };
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, `${CODEX_RELEASE_API_ROOT}/latest`);
  assert.equal(requests[0]?.headers["If-None-Match"], "etag-one");
  assert.equal(result.status, "not-modified");
});

test("daily edge advisory stays on the first page and failures become quiet skip results", async () => {
  let requests = 0;
  const observed = await detectCodexReleaseAdvisory({
    channel: "edge",
    cache: { lastKnownVersion: "0.144.6" },
    now: () => published,
    fetchJson: async () => {
      requests += 1;
      return {
        status: 200,
        data: [release("rust-v0.145.0-alpha.18", true)],
        nextUrl: "https://example.test/ignored-page-two",
      };
    },
  });
  assert.equal(requests, 1);
  assert.equal(observed.status, "observed");
  if (observed.status === "observed") assert.equal(observed.newer, true);

  const offline = await detectCodexReleaseAdvisory({
    channel: "stable",
    now: () => published,
    fetchJson: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(offline, {
    status: "skipped",
    channel: "stable",
    endpoint: `${CODEX_RELEASE_API_ROOT}/latest`,
    checkedAt: published,
    etag: null,
    reason: "offline",
  });
});

test("authoritative stable resolution calls latest once while edge follows pagination", async () => {
  let stableCalls = 0;
  const stable = await resolveCodexSourceRelease({
    channel: "stable",
    now: () => published,
    fetchJson: async () => {
      stableCalls += 1;
      return {
        status: 200,
        etag: "stable-etag",
        bodySha256: "f".repeat(64),
        data: release("rust-v0.144.6", false),
      };
    },
  });
  assert.equal(stableCalls, 1);
  assert.equal(stable.resolvedTag, "rust-v0.144.6");
  assert.equal(stable.etag, "stable-etag");
  assert.equal(stable.responseBodySha256, "f".repeat(64));

  const pages: string[] = [];
  const edge = await resolveCodexSourceRelease({
    channel: "edge",
    now: () => published,
    fetchJson: async (request) => {
      pages.push(request.url);
      if (pages.length === 1) {
        return {
          status: 200,
          etag: "edge-etag",
          data: [release("rust-v0.145.0-alpha.9", true)],
          nextUrl: "https://api.github.test/page/2",
        };
      }
      return { status: 200, data: [release("rust-v0.145.0-alpha.18", true)] };
    },
  });
  assert.deepEqual(pages, [`${CODEX_RELEASE_API_ROOT}?per_page=100`, "https://api.github.test/page/2"]);
  assert.equal(edge.normalizedVersion, "0.145.0-alpha.18");
  assert.equal(edge.etag, "edge-etag");
});

test("authoritative bundled resolution queries the exact installed version tag", async () => {
  const requests: GitHubJsonRequest[] = [];
  const resolved = await resolveCodexSourceRelease({
    channel: "bundled",
    bundledVersion: "0.145.0-alpha.18",
    now: () => published,
    fetchJson: async (request) => {
      requests.push(request);
      return {
        status: 200,
        data: release("rust-v0.145.0-alpha.18", true),
      };
    },
  });
  assert.equal(requests[0]?.url, `${CODEX_RELEASE_API_ROOT}/tags/rust-v0.145.0-alpha.18`);
  assert.equal(resolved.normalizedVersion, "0.145.0-alpha.18");
  assert.equal(resolved.channel, "bundled");
});

test("annotated tag peeling records every object and drift checks compare peeled commits", async () => {
  const identity = await peelCodexTag({
    tag: "rust-v0.144.6",
    ref: { sha: commitA, type: "tag" },
    fetchTagObject: async (sha) => sha === commitA
      ? { sha: commitB, type: "tag" }
      : { sha: "c".repeat(40), type: "commit" },
  });
  assert.deepEqual(identity, {
    tag: "rust-v0.144.6",
    refSha: commitA,
    tagObjectShas: [commitA, commitB],
    peeledCommit: "c".repeat(40),
  });
  assert.throws(() => assertTagIdentityStable([
    identity,
    { ...identity, peeledCommit: "d".repeat(40) },
  ]), /tag drift/);
});

test("npm corroboration proceeds on lag/unavailable and aborts when npm leads", () => {
  assert.equal(evaluateNpmAgreement({
    channel: "stable",
    githubVersion: "0.144.6",
    npmVersions: ["0.144.5", "0.145.0-alpha.18"],
  }).status, "npm-behind");
  assert.equal(evaluateNpmAgreement({
    channel: "stable",
    githubVersion: "0.144.6",
    npmVersions: null,
  }).status, "npm-unavailable");
  const ahead = evaluateNpmAgreement({
    channel: "stable",
    githubVersion: "0.144.6",
    npmVersions: ["0.144.7"],
  });
  assert.equal(ahead.status, "abort-npm-ahead");
  assert.throws(() => assertNpmDoesNotLead(ahead), /ahead/);

  assert.equal(evaluateNpmAgreement({
    channel: "bundled",
    githubVersion: "0.145.0-alpha.18",
    npmVersions: ["0.145.0-alpha.18", "0.145.0-alpha.24"],
  }).status, "corroborated");
});

test("promotion floors are per channel and exact transactional rollback is the only downgrade escape", () => {
  const floors = {
    stable: { version: "0.144.6", peeledCommit: commitA },
    edge: { version: "0.145.0-alpha.18", peeledCommit: commitB },
  } as const;
  assert.doesNotThrow(() => assertChannelPromotionAllowed({
    channel: "stable",
    candidateVersion: "0.144.6",
    candidateCommit: commitA,
    floors,
  }));
  assert.throws(() => assertChannelPromotionAllowed({
    channel: "edge",
    candidateVersion: "0.145.0-alpha.9",
    candidateCommit: commitA,
    floors,
  }), /downgrade refused/);
  assert.doesNotThrow(() => assertChannelPromotionAllowed({
    channel: "edge",
    candidateVersion: "0.145.0-alpha.9",
    candidateCommit: commitA,
    floors,
    exactRollback: { version: "0.145.0-alpha.9", peeledCommit: commitA },
  }));
});

function release(tag: string, prerelease: boolean) {
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    published_at: published,
    html_url: `https://example.test/${tag}`,
  };
}

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_PUBLIC_PRODUCTION_APPCAST,
  probeDesktopAppcast,
  type DesktopAppcastFetch,
} from "../src/desktop-appcast-probe";

const SIGNATURE = Buffer.alloc(64, 7).toString("base64");

function appcastXml(items: Array<{ version: string; build: string; signature?: string | null; url?: string }>): string {
  const body = items.map((item) => `
    <item>
      <title>${item.version}</title>
      <enclosure url="${item.url ?? "https://persistent.oaistatic.com/codex-app-prod/app.zip"}"
        sparkle:shortVersionString="${item.version}"
        sparkle:version="${item.build}"
        ${item.signature === null ? "" : `sparkle:edSignature="${item.signature ?? SIGNATURE}"`}
        length="1" type="application/octet-stream" />
    </item>`).join("\n");
  return `<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>${body}</channel></rss>`;
}

function fetchReturning(xml: string, overrides: Partial<{ status: number; url: string; location: string | null }> = {}): DesktopAppcastFetch {
  return async (url) => ({
    ok: (overrides.status ?? 200) === 200,
    status: overrides.status ?? 200,
    url: overrides.url ?? url,
    headers: { get: (name: string) => (name.toLowerCase() === "location" ? overrides.location ?? null : null) },
    arrayBuffer: async () => Uint8Array.from(Buffer.from(xml, "utf8")).buffer,
  });
}

function fixtureApp(feedUrl?: string): { appPath: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "appcast-probe-"));
  const appPath = join(root, "ChatGPT.app");
  mkdirSync(join(appPath, "Contents"), { recursive: true });
  const feedEntry = feedUrl === undefined ? "" : `<key>SUFeedURL</key><string>${feedUrl}</string>`;
  writeFileSync(join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${feedEntry}</dict></plist>`);
  return { appPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const BASELINE = { marketingVersion: "26.814.41407", build: "6720" };

test("a newer signed release reports update-available; equal and older report current", async () => {
  const app = fixtureApp("https://feeds.example.com/appcast.xml");
  try {
    const newer = await probeDesktopAppcast({
      appPath: app.appPath,
      baseline: BASELINE,
      fetch: fetchReturning(appcastXml([{ version: "26.814.41957", build: "6744" }])),
    });
    assert.equal(newer.state, "update-available");
    assert.equal(newer.latestBuild, "6744");
    assert.equal(newer.feedUrl, "https://feeds.example.com/appcast.xml");

    for (const build of ["6720", "6662"]) {
      const result = await probeDesktopAppcast({
        appPath: app.appPath,
        baseline: BASELINE,
        fetch: fetchReturning(appcastXml([{ version: "26.814.41407", build }])),
      });
      assert.equal(result.state, "current", `build ${build}`);
    }

    // BigInt ordering: the numerically largest build wins, not the last item.
    const multi = await probeDesktopAppcast({
      appPath: app.appPath,
      baseline: BASELINE,
      fetch: fetchReturning(appcastXml([
        { version: "26.814.41957", build: "6744" },
        { version: "26.810.52044", build: "6662" },
      ])),
    });
    assert.equal(multi.latestBuild, "6744");
  } finally { app.cleanup(); }
});

test("ambiguity always fails open as unavailable", async () => {
  const app = fixtureApp("https://feeds.example.com/appcast.xml");
  try {
    const cases: Array<[string, DesktopAppcastFetch]> = [
      ["malformed xml", fetchReturning("<html>not an appcast</html>")],
      ["unsigned enclosure", fetchReturning(appcastXml([{ version: "27.0.0", build: "9000", signature: null }]))],
      ["http enclosure", fetchReturning(appcastXml([{ version: "27.0.0", build: "9000", url: "http://insecure.example.com/a.zip" }]))],
      ["server error", fetchReturning(appcastXml([{ version: "27.0.0", build: "9000" }]), { status: 500 })],
      ["network failure", async () => { throw new Error("offline"); }],
      ["redirect without location", fetchReturning("", { status: 302, location: null })],
    ];
    for (const [name, fetcher] of cases) {
      const result = await probeDesktopAppcast({ appPath: app.appPath, baseline: BASELINE, fetch: fetcher });
      assert.equal(result.state, "unavailable", name);
    }

    const unreadableBaseline = await probeDesktopAppcast({
      appPath: app.appPath,
      baseline: { marketingVersion: null, build: null },
      fetch: fetchReturning(appcastXml([{ version: "27.0.0", build: "9000" }])),
    });
    assert.equal(unreadableBaseline.state, "unavailable");
  } finally { app.cleanup(); }
});

test("insecure redirects are rejected and the feed URL falls back to the production constant", async () => {
  const app = fixtureApp("https://feeds.example.com/appcast.xml");
  const noFeed = fixtureApp();
  const insecureFeed = fixtureApp("http://insecure.example.com/appcast.xml");
  try {
    const insecureRedirect = await probeDesktopAppcast({
      appPath: app.appPath,
      baseline: BASELINE,
      fetch: fetchReturning("", { status: 302, location: "http://insecure.example.com/appcast.xml" }),
    });
    assert.equal(insecureRedirect.state, "unavailable");
    assert.match(insecureRedirect.detail, /insecure redirect rejected/);

    for (const fixture of [noFeed, insecureFeed]) {
      const result = await probeDesktopAppcast({
        appPath: fixture.appPath,
        baseline: BASELINE,
        fetch: fetchReturning(appcastXml([{ version: "26.814.41957", build: "6744" }])),
      });
      assert.equal(result.feedUrl, CODEX_PUBLIC_PRODUCTION_APPCAST);
      assert.equal(result.state, "update-available");
    }
  } finally {
    app.cleanup();
    noFeed.cleanup();
    insecureFeed.cleanup();
  }
});

test("oversized appcast bodies are rejected", async () => {
  const app = fixtureApp("https://feeds.example.com/appcast.xml");
  try {
    const result = await probeDesktopAppcast({
      appPath: app.appPath,
      baseline: BASELINE,
      maxBytes: 64,
      fetch: fetchReturning(appcastXml([{ version: "27.0.0", build: "9000" }])),
    });
    assert.equal(result.state, "unavailable");
    assert.match(result.detail, /response too large/);
  } finally { app.cleanup(); }
});

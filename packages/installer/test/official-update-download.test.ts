import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performDirectOfficialUpdate, type DirectOfficialUpdateDeps } from "../src/official-update-download";
import type { EnvironmentSelection } from "../src/environment-profile";

const LATEST = { marketingVersion: "26.818.32112", build: "6933" };

function makeSelection(appPath: string): EnvironmentSelection {
  return {
    selectedDesktopPath: appPath,
    selectedDesktopBundleId: "com.openai.codex",
    releaseProfile: "stable",
    appExperience: "chatgpt",
    backendLane: "official-bundled",
    uiFeatures: "off",
    mcpSafetyProvider: "official-bundled-degraded",
    recoveryState: "pristine-openai-recovery",
    migrationState: "verified",
    quarantineReason: null,
    requestedAt: "2026-08-21T21:00:00.000Z",
    appliedAt: "2026-08-21T21:00:00.000Z",
  } as EnvironmentSelection;
}

function writeApp(root: string, overrides: Partial<Record<"bundleId" | "version" | "build", string>> = {}): void {
  mkdirSync(join(root, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(root, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>`
    + `<key>CFBundleIdentifier</key><string>${overrides.bundleId ?? "com.openai.codex"}</string>`
    + `<key>CFBundleShortVersionString</key><string>${overrides.version ?? LATEST.marketingVersion}</string>`
    + `<key>CFBundleVersion</key><string>${overrides.build ?? LATEST.build}</string>`
    + `</dict></plist>`);
  writeFileSync(join(root, "Contents", "Resources", "app.asar"), "official-payload");
}

function zipApp(root: string, appName = "ChatGPT.app"): Buffer {
  const archive = join(root, "archive.zip");
  const zipped = spawnSync("ditto", ["-c", "-k", "--keepParent", join(root, appName), archive]);
  assert.equal(zipped.status, 0, zipped.stderr?.toString());
  return readFileSync(archive);
}

function fetchServing(bytes: Buffer, contentLength: string | null = String(bytes.byteLength)): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? contentLength : null) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from(bytes));
        controller.close();
      },
    }),
  })) as unknown as typeof fetch;
}

function passingDeps(events: string[], overrides: Partial<DirectOfficialUpdateDeps> = {}): DirectOfficialUpdateDeps {
  return {
    verifySignature: () => ({ ok: true, output: "" }),
    signatureInfo: () => ({
      ok: true,
      adHoc: false,
      teamIdentifier: "2DC432GLL2",
      authority: ["Developer ID Application: OpenAI, L.L.C. (2DC432GLL2)"],
      output: "",
    }),
    assessGatekeeper: () => true,
    quitApp: () => { events.push("quit"); },
    isAppRunning: () => false,
    openApp: () => { events.push("open"); },
    sleep: async () => {},
    ...overrides,
  };
}

function fixture(): { root: string; live: string; zip: Buffer; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "direct-update-"));
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  writeApp(join(source, "ChatGPT.app"));
  const zip = zipApp(source);
  const live = join(root, "Applications", "ChatGPT.app");
  writeApp(live, { version: "26.818.22352", build: "6872" });
  return { root, live, zip, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function input(f: ReturnType<typeof fixture>) {
  return {
    selection: makeSelection(f.live),
    latest: LATEST,
    enclosureUrl: "https://persistent.oaistatic.com/codex-app-prod/app.zip",
    enclosureLength: f.zip.byteLength,
    workRoot: join(f.root, "work"),
  };
}

test("a verified appcast enclosure installs directly: download, verify, quit, swap, reopen", async () => {
  const f = fixture();
  try {
    const events: string[] = [];
    const installed = await performDirectOfficialUpdate(input(f), {
      ...passingDeps(events),
      fetch: fetchServing(f.zip),
    });

    assert.deepEqual(installed, { marketingVersion: LATEST.marketingVersion, build: LATEST.build });
    assert.deepEqual(events, ["quit", "open"], "reopen always follows the quit");
    assert.equal(readFileSync(join(f.live, "Contents", "Info.plist"), "utf8").includes("6933"), true);
    // No staging debris: work root and both rename siblings are gone.
    assert.equal(existsSync(join(f.root, "work")), false);
    assert.deepEqual(
      readdirSync(join(f.root, "Applications")).filter((name) => name !== "ChatGPT.app"),
      [],
    );
  } finally { f.cleanup(); }
});

test("Sparkle's install-on-quit result wins: an already-current disk version skips the swap", async () => {
  const f = fixture();
  try {
    const events: string[] = [];
    const deps = passingDeps(events, {
      quitApp: () => {
        events.push("quit");
        // Sparkle finishes its staged install the moment the app exits.
        rmSync(f.live, { recursive: true, force: true });
        writeApp(f.live);
      },
    });
    const installed = await performDirectOfficialUpdate(input(f), { ...deps, fetch: fetchServing(f.zip) });
    assert.deepEqual(installed, { marketingVersion: LATEST.marketingVersion, build: LATEST.build });
    assert.deepEqual(events, ["quit", "open"]);
  } finally { f.cleanup(); }
});

test("every failure past the quit still reopens the app, and an abort stops before the quit", async () => {
  const f = fixture();
  try {
    // Failure after quit (app refuses to settle): the desktop is reopened.
    const stuck: string[] = [];
    let polls = 0;
    await assert.rejects(
      performDirectOfficialUpdate(input(f), {
        ...passingDeps(stuck, { isAppRunning: () => { polls += 1; return true; } }),
        fetch: fetchServing(f.zip),
      }),
      /did not quit/,
    );
    assert.equal(stuck.includes("open"), true, "the app must be reopened after a post-quit failure");
    assert.equal(polls > 0, true);

    // Abort (e.g. a cancel landed on the receipt): nothing is quit or
    // swapped. shouldAbort rides the INPUT - the exact shape the production
    // adapter forwards - never a test-only deps seam.
    const aborted: string[] = [];
    await assert.rejects(
      performDirectOfficialUpdate(
        { ...input(f), shouldAbort: () => true },
        { ...passingDeps(aborted), fetch: fetchServing(f.zip) },
      ),
      /aborted before touching the live app/,
    );
    assert.deepEqual(aborted, []);

    // A cancel landing DURING the slow staging/verify window still stops the
    // quit itself: first consult passes, the pre-quit consult aborts.
    const lateAbort: string[] = [];
    let consults = 0;
    await assert.rejects(
      performDirectOfficialUpdate(
        { ...input(f), shouldAbort: () => { consults += 1; return consults > 1; } },
        { ...passingDeps(lateAbort), fetch: fetchServing(f.zip) },
      ),
      /aborted before touching the live app/,
    );
    assert.deepEqual(lateAbort, [], "the quit must never run after a staging-window cancel");
    assert.equal(readFileSync(join(f.live, "Contents", "Info.plist"), "utf8").includes("6872"), true);
  } finally { f.cleanup(); }
});

test("the direct install refuses untrusted, mismatched, or oversized archives before touching the live app", async () => {
  const f = fixture();
  try {
    const liveBefore = readFileSync(join(f.live, "Contents", "Info.plist"), "utf8");
    const events: string[] = [];

    await assert.rejects(
      performDirectOfficialUpdate(input(f), {
        ...passingDeps(events),
        fetch: fetchServing(f.zip),
        signatureInfo: () => ({ ok: true, adHoc: false, teamIdentifier: "NOTOPENAI", authority: [], output: "" }),
      }),
      /not signed by OpenAI Team/,
    );
    await assert.rejects(
      performDirectOfficialUpdate(
        { ...input(f), latest: { marketingVersion: "27.0.0", build: "9999" } },
        { ...passingDeps(events), fetch: fetchServing(f.zip) },
      ),
      /does not match the signed appcast item/,
    );
    await assert.rejects(
      performDirectOfficialUpdate(input(f), {
        ...passingDeps(events),
        fetch: fetchServing(f.zip, String(64 * 1024 * 1024 * 1024)),
      }),
      /exceeds the size bound/,
    );
    await assert.rejects(
      performDirectOfficialUpdate(
        { ...input(f), enclosureUrl: "http://insecure.example.com/app.zip" },
        { ...passingDeps(events), fetch: fetchServing(f.zip) },
      ),
      /transport must be HTTPS/,
    );
    // A redirect may not downgrade the transport either.
    await assert.rejects(
      performDirectOfficialUpdate(input(f), {
        ...passingDeps(events),
        fetch: (async () => ({
          ok: true,
          status: 302,
          headers: { get: (name: string) => (name.toLowerCase() === "location" ? "http://insecure.example.com/app.zip" : null) },
          body: null,
        })) as unknown as typeof fetch,
      }),
      /transport must be HTTPS/,
    );
    // A truncated body that contradicts the enclosure length is refused.
    await assert.rejects(
      performDirectOfficialUpdate(
        { ...input(f), enclosureLength: f.zip.byteLength + 1000 },
        { ...passingDeps(events), fetch: fetchServing(f.zip) },
      ),
      /length does not match/,
    );

    assert.deepEqual(events, [], "no quit, swap, or reopen may run for a refused archive");
    assert.equal(readFileSync(join(f.live, "Contents", "Info.plist"), "utf8"), liveBefore);
  } finally { f.cleanup(); }
});

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
    replaceApp: (staged, destination, adapters) => {
      events.push("replace");
      assert.equal(existsSync(join(staged, "Contents", "Info.plist")), true);
      assert.equal(adapters?.validateDestination?.(staged), true, "the destination validator must accept a verified bundle");
      rmSync(destination, { recursive: true, force: true });
      spawnSync("ditto", [staged, destination]);
    },
    sleep: async () => {},
    ...overrides,
  };
}

test("a verified appcast enclosure installs directly: download, verify, quit, swap, reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "direct-update-"));
  try {
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    writeApp(join(source, "ChatGPT.app"));
    const zip = zipApp(source);
    const live = join(root, "Applications", "ChatGPT.app");
    writeApp(live, { version: "26.818.22352", build: "6872" });
    const events: string[] = [];

    const installed = await performDirectOfficialUpdate({
      selection: makeSelection(live),
      latest: LATEST,
      enclosureUrl: "https://persistent.oaistatic.com/codex-app-prod/app.zip",
      enclosureLength: zip.byteLength,
      workRoot: join(root, "work"),
    }, { ...passingDeps(events), fetch: fetchServing(zip) });

    assert.deepEqual(installed, { marketingVersion: LATEST.marketingVersion, build: LATEST.build });
    assert.deepEqual(events, ["quit", "replace", "open"]);
    assert.equal(readFileSync(join(live, "Contents", "Info.plist"), "utf8").includes("6933"), true);
    // The staging work root never survives the attempt.
    assert.equal(existsSync(join(root, "work")) ? readdirSync(join(root, "work")).length : 0, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the direct install refuses untrusted, mismatched, or oversized archives before touching the live app", async () => {
  const root = mkdtempSync(join(tmpdir(), "direct-update-"));
  try {
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    writeApp(join(source, "ChatGPT.app"));
    const zip = zipApp(source);
    const live = join(root, "Applications", "ChatGPT.app");
    writeApp(live, { version: "26.818.22352", build: "6872" });
    const input = {
      selection: makeSelection(live),
      latest: LATEST,
      enclosureUrl: "https://persistent.oaistatic.com/codex-app-prod/app.zip",
      enclosureLength: zip.byteLength,
      workRoot: join(root, "work"),
    };
    const liveBytesBefore = readFileSync(join(live, "Contents", "Info.plist"), "utf8");
    const events: string[] = [];

    await assert.rejects(
      performDirectOfficialUpdate(input, {
        ...passingDeps(events),
        fetch: fetchServing(zip),
        signatureInfo: () => ({ ok: true, adHoc: false, teamIdentifier: "NOTOPENAI", authority: [], output: "" }),
      }),
      /not signed by OpenAI Team/,
    );
    await assert.rejects(
      performDirectOfficialUpdate(
        { ...input, latest: { marketingVersion: "27.0.0", build: "9999" } },
        { ...passingDeps(events), fetch: fetchServing(zip) },
      ),
      /does not match the signed appcast item/,
    );
    await assert.rejects(
      performDirectOfficialUpdate(input, {
        ...passingDeps(events),
        fetch: fetchServing(zip, String(64 * 1024 * 1024 * 1024)),
      }),
      /exceeds the size bound/,
    );
    await assert.rejects(
      performDirectOfficialUpdate(
        { ...input, enclosureUrl: "http://insecure.example.com/app.zip" },
        { ...passingDeps(events), fetch: fetchServing(zip) },
      ),
      /transport must be HTTPS/,
    );

    assert.deepEqual(events, [], "no quit, swap, or reopen may run for a refused archive");
    assert.equal(readFileSync(join(live, "Contents", "Info.plist"), "utf8"), liveBytesBefore);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

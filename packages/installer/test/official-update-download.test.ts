import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareOfficialUpdateSource, performDirectOfficialUpdate, reconcileDirectOfficialUpdateDebris, type DirectOfficialUpdateDeps } from "../src/official-update-download";
import { writeDoctorPrivateJson } from "../src/doctor-store";
import { lstatSync } from "node:fs";
import { failedOfficialSourceJournalPath, reconcileFailedOfficialSource } from "../src/artifact-maintenance";
import { readReservations } from "../src/local-artifacts";
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

function passingDeps(f: ReturnType<typeof fixture>, events: string[], overrides: Partial<DirectOfficialUpdateDeps> = {}): DirectOfficialUpdateDeps {
  mkdirSync(join(f.root,"artifact-state"),{recursive:true,mode:0o700});
  chmodSync(join(f.root,"artifact-state"),0o700);
  return {
    artifactRoot: () => join(f.root, "artifact-state"),
    installedTweakersPath: () => join(f.root, "Tweakers.app"),
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "direct-update-")));
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
      ...passingDeps(f, events),
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
    const deps = passingDeps(f, events, {
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

test("direct update retry reconciles only journaled pre-cutover debris", () => {
  const f = fixture();
  try {
    const artifactRoot = join(f.root,"artifact-state");
    mkdirSync(artifactRoot,{mode:0o700});
    const workRoot = join(f.root,"work");
    const stagedSibling = `${f.live}.tweakers-direct-staged`;
    const previousSibling = `${f.live}.tweakers-direct-previous`;
    mkdirSync(workRoot);
    writeApp(stagedSibling);
    const appStat = lstatSync(f.live), workStat = lstatSync(workRoot), stagedStat = lstatSync(stagedSibling);
    const journal = {version:1, appPath:f.live, workRoot, stagedSibling, previousSibling, latest:LATEST,
      appIdentity:{dev:appStat.dev,ino:appStat.ino}, workIdentity:{dev:workStat.dev,ino:workStat.ino},
      stagedIdentity:{dev:stagedStat.dev,ino:stagedStat.ino}, phase:"staged"};
    writeDoctorPrivateJson(join(artifactRoot,"direct-official-update.json"), journal);
    reconcileDirectOfficialUpdateDebris(artifactRoot,f.live,workRoot);
    assert.equal(existsSync(workRoot),false);
    assert.equal(existsSync(stagedSibling),false);
    assert.equal(existsSync(f.live),true);
    assert.equal(existsSync(join(artifactRoot,"direct-official-update.json")),false);

    mkdirSync(workRoot);
    writeApp(stagedSibling);
    writeApp(previousSibling);
    writeDoctorPrivateJson(join(artifactRoot,"direct-official-update.json"), journal);
    assert.throws(()=>reconcileDirectOfficialUpdateDebris(artifactRoot,f.live,workRoot),/manual reconciliation/);
    assert.equal(existsSync(previousSibling),true,"possible rollback remains intact");
    assert.equal(existsSync(stagedSibling),true,"ambiguous candidate remains intact");
  } finally { f.cleanup(); }
});

test("direct update retry clears a completed journal after rechecking the installed signature", () => {
  const f = fixture();
  try {
    const artifactRoot = join(f.root,"artifact-state"), workRoot = join(f.root,"work");
    mkdirSync(artifactRoot,{mode:0o700});
    mkdirSync(workRoot);
    const before = lstatSync(f.live), work = lstatSync(workRoot);
    const journal = {version:1,appPath:f.live,workRoot,stagedSibling:`${f.live}.tweakers-direct-staged`,
      previousSibling:`${f.live}.tweakers-direct-previous`,latest:LATEST,
      appIdentity:{dev:before.dev,ino:before.ino},workIdentity:{dev:work.dev,ino:work.ino},phase:"completed"};
    writeDoctorPrivateJson(join(artifactRoot,"direct-official-update.json"),journal);
    rmSync(f.live,{recursive:true});
    writeApp(f.live);
    reconcileDirectOfficialUpdateDebris(artifactRoot,f.live,workRoot,passingDeps(f,[]).signatureInfo!);
    assert.equal(existsSync(workRoot),false);
    assert.equal(existsSync(join(artifactRoot,"direct-official-update.json")),false);
    assert.equal(existsSync(f.live),true);
  } finally {f.cleanup();}
});

test("every failure past the quit still reopens the app, and an abort stops before the quit", async () => {
  const f = fixture();
  try {
    // Failure after quit (app refuses to settle): the desktop is reopened.
    const stuck: string[] = [];
    let polls = 0;
    await assert.rejects(
      performDirectOfficialUpdate(input(f), {
        ...passingDeps(f, stuck, { isAppRunning: () => { polls += 1; return true; } }),
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
        { ...passingDeps(f, aborted), fetch: fetchServing(f.zip) },
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
        { ...passingDeps(f, lateAbort), fetch: fetchServing(f.zip) },
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
    const clearFailedPreparation = async () => {
      const artifactRoot=join(f.root,"artifact-state"), trash=join(f.root,"Trash");
      mkdirSync(trash,{recursive:true,mode:0o700});
      const active=readReservations(artifactRoot).filter(item=>item.state!=="retired"&&item.paths.some(path=>path.endsWith("/extracted/ChatGPT.app")&&existsSync(path)));
      assert.equal(active.length,1);
      await reconcileFailedOfficialSource(artifactRoot,active[0]!.id,true,trash);
    };

    await assert.rejects(
      performDirectOfficialUpdate(input(f), {
        ...passingDeps(f, events),
        fetch: fetchServing(f.zip),
        signatureInfo: () => ({ ok: true, adHoc: false, teamIdentifier: "NOTOPENAI", authority: [], output: "" }),
      }),
      /not signed by OpenAI Team/,
    );
    await clearFailedPreparation();
    await assert.rejects(
      performDirectOfficialUpdate(
        { ...input(f), latest: { marketingVersion: "27.0.0", build: "9999" } },
        { ...passingDeps(f, events), fetch: fetchServing(f.zip) },
      ),
      /does not match the signed appcast item/,
    );
    await clearFailedPreparation();
    await assert.rejects(
      performDirectOfficialUpdate(input(f), {
        ...passingDeps(f, events),
        fetch: fetchServing(f.zip, String(64 * 1024 * 1024 * 1024)),
      }),
      /exceeds the size bound/,
    );
    await assert.rejects(
      performDirectOfficialUpdate(
        { ...input(f), enclosureUrl: "http://insecure.example.com/app.zip" },
        { ...passingDeps(f, events), fetch: fetchServing(f.zip) },
      ),
      /transport must be HTTPS/,
    );
    // A redirect may not downgrade the transport either.
    await assert.rejects(
      performDirectOfficialUpdate(input(f), {
        ...passingDeps(f, events),
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
        { ...passingDeps(f, events), fetch: fetchServing(f.zip) },
      ),
      /length does not match/,
    );

    assert.deepEqual(events, [], "no quit, swap, or reopen may run for a refused archive");
    assert.equal(readFileSync(join(f.live, "Contents", "Info.plist"), "utf8"), liveBefore);
  } finally { f.cleanup(); }
});


test("Doctor preparation validates and retains upstream without quitting or replacing the live app", async () => {
  const f = fixture();
  try {
    const events: string[] = [];
    const before = readFileSync(join(f.live, "Contents", "Info.plist"), "utf8");
    const staged = await prepareOfficialUpdateSource(input(f), { ...passingDeps(f, events), fetch: fetchServing(f.zip) });
    assert.deepEqual(events, []);
    assert.equal(readFileSync(join(f.live, "Contents", "Info.plist"), "utf8"), before);
    assert.ok(existsSync(staged));
    assert.ok(readFileSync(join(staged, "Contents", "Info.plist"), "utf8").includes(LATEST.build));
    assert.ok(existsSync(join(f.root, "work")), "Caller owns retained preparation output");
  } finally { f.cleanup(); }
});

test("invalid extracted official source stays reserved until explicit journaled Trash reconciliation", async () => {
  const f=fixture();
  try {
    const artifactRoot=join(f.root,"artifact-state"), workRoot=join(f.root,"failed-upstream");
    const events:string[]=[];
    await assert.rejects(prepareOfficialUpdateSource({...input(f),workRoot},{
      ...passingDeps(f,events),fetch:fetchServing(f.zip),
      signatureInfo:()=>({ok:true,adHoc:false,teamIdentifier:"WRONG",authority:[],output:""}),
    }),/not signed by OpenAI Team/);
    const source=join(workRoot,"extracted","ChatGPT.app");
    assert.equal(existsSync(source),true);
    const active=readReservations(artifactRoot).filter(item=>item.state!=="retired"&&item.paths.includes(source));
    assert.equal(active.length,1);
    const journal=failedOfficialSourceJournalPath(artifactRoot,active[0]!.id);
    assert.equal(JSON.parse(readFileSync(journal,"utf8")).phase,"failed");
    const trash=join(f.root,"Trash");mkdirSync(trash,{mode:0o700});
    const preview=await reconcileFailedOfficialSource(artifactRoot,active[0]!.id,false,trash);
    assert.equal(preview.eligible,true);
    assert.equal(existsSync(source),true);
    // Simulate a crash after the durable receipt and atomic Trash move, before
    // the reservation and journal were marked reconciled.
    const prior=JSON.parse(readFileSync(journal,"utf8"));
    const destination=join(trash,`Tweakers-failed-source-${active[0]!.id}`);
    writeDoctorPrivateJson(join(artifactRoot,"artifact-archives","failed-official-sources",`${active[0]!.id}.json`),{
      version:1,kind:"failed-official-source-retirement",reservationId:active[0]!.id,
      original:workRoot,destination,identity:prior.identity,phase:"prepared"});
    writeDoctorPrivateJson(journal,{...prior,phase:"prepared"});
    renameSync(workRoot,destination);
    const applied=await reconcileFailedOfficialSource(artifactRoot,active[0]!.id,true,trash);
    assert.equal(applied.retired,true);
    assert.equal(existsSync(source),false);
    assert.equal(readReservations(artifactRoot).find(item=>item.id===active[0]!.id)?.state,"retired");
    const receipt=JSON.parse(readFileSync(join(artifactRoot,"artifact-archives","failed-official-sources",`${active[0]!.id}.json`),"utf8"));
    assert.equal(receipt.phase,"retired");
    assert.equal(existsSync(receipt.destination),true);
  }finally{f.cleanup();}
});

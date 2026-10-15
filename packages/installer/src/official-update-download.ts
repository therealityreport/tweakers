import { prepareLocalArtifactSlot, retireSupersededDoctorSource } from "./artifact-retirement.js";
import { withLocalOperation } from "./local-operation.js";
import { reserveLocalArtifact, assertLocalExecutionPath, moveReservedLocalArtifact, readReservations, releaseEmptyLocalArtifactReservation } from "./local-artifacts.js";
import { canonicalTweakersManagerRoot } from "./manager-descriptor.js";
import { readDoctorPrivateJson, writeDoctorPrivateJson } from "./doctor-store.js";
import { hasUnreconciledFailedSource, recordFailedOfficialSource } from "./artifact-maintenance.js";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCodexMainProcessRunning, openCodex, quitCodex } from "./alerts.js";
import { signatureInfo, verifySignature } from "./codesign.js";
import { OPENAI_TEAM_ID } from "./macos-variant.js";
import { readPlist } from "./plist.js";
import type { EnvironmentSelection } from "./environment-profile.js";

/**
 * Direct, feed-driven official desktop update.
 *
 * Sparkle's native updater is the preferred install path, but its handoff is
 * an Automation (AppleScript) menu click that macOS TCC can deny, and phased
 * rollouts can leave the passive disk wait to time out with nothing installed
 * (both observed live 2026-08-21). This module makes the update loop work
 * unattended anyway: download the release archive named by the HTTPS appcast,
 * verify the extracted bundle with the exact trust chain the environment
 * validators already require - strict deep codesign, Developer ID (never
 * ad-hoc), the OpenAI team identifier, Gatekeeper assessment, the expected
 * bundle identity, and the exact advertised version/build - then swap it in
 * atomically and reopen.
 *
 * Trust anchor: the Sparkle Ed25519 enclosure signature is shape-checked by
 * the appcast probe but cannot be cryptographically verified here (OpenAI's
 * Sparkle public key ships inside the app, not to us). The load-bearing
 * verification is Apple's: a strict deep code signature by OpenAI's Developer
 * ID plus a Gatekeeper assessment of the extracted bundle - the same proof
 * the rest of the installer trusts for every official payload.
 *
 * Ordering guarantees:
 *  - every check runs against the STAGED bundle before the live app is
 *    touched; a refused archive changes nothing;
 *  - once the live app has been quit, this function either completes the
 *    swap or REOPENS the app before surfacing the failure - it never leaves
 *    the desktop closed;
 *  - if Sparkle's own install-on-quit already advanced the app past the
 *    target while we quit it, that result wins and the swap is skipped.
 */

export const DIRECT_UPDATE_HARD_BYTE_LIMIT = 3 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const QUIT_SETTLE_ATTEMPTS = 30;
const QUIT_SETTLE_INTERVAL_MS = 1_000;
const MAX_REDIRECTS = 4;
/** An app bundle legitimately decompresses larger than its zip; a bomb explodes. */
const EXTRACTION_INFLATION_LIMIT = 6;

export interface DirectOfficialUpdateInput {
  selection: EnvironmentSelection;
  latest: { marketingVersion: string; build: string };
  enclosureUrl: string;
  enclosureLength: number | null;
  workRoot: string;
  /**
   * Abort channel consulted before staging, before the quit, and before the
   * swap. Lives on the INPUT (not the deps) so the transaction's adapter
   * forwards it structurally - a deps-side twin was silently unwired in
   * production and both checks were no-ops (re-audit 2026-08-21).
   */
  shouldAbort?: () => boolean;
}

export interface DirectOfficialUpdateDeps {
  artifactRoot?: () => string;
  installedTweakersPath?: () => string;
  fetch?: typeof fetch;
  execFileSync?: (command: string, args: string[]) => void;
  verifySignature?: typeof verifySignature;
  signatureInfo?: typeof signatureInfo;
  assessGatekeeper?: (appPath: string) => boolean;
  quitApp?: (appPath: string) => void;
  isAppRunning?: (appPath: string) => boolean;
  openApp?: (appPath: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Download and verify only. Caller owns durable output and cleanup; never quits or installs. */
export async function prepareOfficialUpdateSource(
  input: DirectOfficialUpdateInput,
  deps: DirectOfficialUpdateDeps = {},
): Promise<string> {
  return withLocalOperation("prepare official update source",async()=>{
  const workRoot = input.workRoot;
  const extracted = join(workRoot, "extracted");
  const artifactRoot = (deps.artifactRoot ?? canonicalTweakersManagerRoot)();
  const installed = deps.installedTweakersPath?.() ?? "/Applications/Tweakers.app";
  await retireSupersededDoctorSource(artifactRoot, installed, input.latest.build);
  await prepareLocalArtifactSlot(artifactRoot, installed);
  const reservation = reserveLocalArtifact(artifactRoot, installed, [join(extracted,"ChatGPT.app")]);
  try {
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
    const archive = join(workRoot, "official-update.zip");
    const archiveBytes = await downloadBounded(
      input.enclosureUrl,
      archive,
      boundedLimit(input.enclosureLength),
      deps.fetch ?? fetch,
    );
    if (input.enclosureLength !== null && Number.isFinite(input.enclosureLength)
      && input.enclosureLength > 0 && archiveBytes !== input.enclosureLength) {
      throw new Error("Direct update archive length does not match the appcast enclosure");
    }

    assertLocalExecutionPath(workRoot);
    // Extraction is disposable: never merge a resumed download into partial old bytes.
    rmSync(extracted, { recursive: true, force: true });
    mkdirSync(extracted, { recursive: true, mode: 0o700 });
    // ditto is the macOS-blessed extractor for signed app archives: it
    // preserves resource forks, xattrs, and symlinks exactly as signed.
    (deps.execFileSync ?? spawnChecked)("ditto", ["-x", "-k", archive, extracted]);
    assertBoundedExtraction(extracted, archiveBytes);
    const verified = locateSingleApp(extracted);
    if(verified!==join(extracted,"ChatGPT.app"))throw new Error("Unexpected prepared source bundle path; retained for reconciliation");
    assertVerifiedOfficialBundle(verified, input, deps);

  return verified;
  } catch (error) {
    // Empty reservations can be released; partial applications remain counted.
    if (!existsSync(join(extracted, "ChatGPT.app"))) releaseEmptyLocalArtifactReservation(artifactRoot, reservation);
    else recordFailedOfficialSource(artifactRoot,reservation,join(extracted,"ChatGPT.app"),workRoot);
    throw error;
  }
  });
}

export async function performDirectOfficialUpdate(
  input: DirectOfficialUpdateInput,
  deps: DirectOfficialUpdateDeps = {},
): Promise<{ marketingVersion: string | null; build: string | null }> {
  return withLocalOperation("direct official update", () => performDirectOfficialUpdateOwned(input, deps));
}
interface DirectUpdateJournal {
  version: 1; appPath: string; workRoot: string; stagedSibling: string; previousSibling: string;
  latest: {marketingVersion:string;build:string};
  appIdentity: {dev: number; ino: number}; workIdentity: {dev: number; ino: number};
  stagedIdentity?: {dev: number; ino: number};
  phase: "preparing" | "staged" | "cutover" | "completed";
}
function directJournalPath(root: string): string { return join(root, "direct-official-update.json"); }
function sameIdentity(path: string, identity: {dev:number;ino:number}): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return !stat.isSymbolicLink() && stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino;
}
/** Reconcile only the pre-cutover payload owned by the exact recorded update. */
export function reconcileDirectOfficialUpdateDebris(root: string, appPath: string, expectedWorkRoot: string,
  inspectSignature: typeof signatureInfo = signatureInfo): void {
  const file = directJournalPath(root);
  if (hasUnreconciledFailedSource(root,expectedWorkRoot))
    throw new Error("Failed official source requires explicit artifact-maintenance reconciliation");
  const journal = readDoctorPrivateJson(file) as DirectUpdateJournal | null;
  if (journal === null) {
    if (existsSync(expectedWorkRoot) || existsSync(`${appPath}.tweakers-direct-staged`)
      || existsSync(`${appPath}.tweakers-direct-previous`)) throw new Error("Unjournaled direct update payloads require manual reconciliation");
    return;
  }
  if (journal.version !== 1 || journal.appPath !== appPath || journal.workRoot !== expectedWorkRoot
    || journal.stagedSibling !== `${appPath}.tweakers-direct-staged`
    || journal.previousSibling !== `${appPath}.tweakers-direct-previous`
    || typeof journal.latest?.marketingVersion !== "string" || typeof journal.latest?.build !== "string"
    || !["preparing", "staged", "cutover", "completed"].includes(journal.phase)
    || !journal.appIdentity || !journal.workIdentity) throw new Error("Direct update journal requires manual reconciliation");
  const completed = journal.phase === "completed" && !existsSync(journal.previousSibling)
    && readBundleIdentity(appPath).marketingVersion === journal.latest.marketingVersion
    && readBundleIdentity(appPath).build === journal.latest.build
    && (() => { const trust = inspectSignature(appPath); return trust.ok && !trust.adHoc && trust.teamIdentifier === OPENAI_TEAM_ID; })();
  if (journal.phase === "cutover" || existsSync(journal.previousSibling)
    || (!completed && !sameIdentity(appPath, journal.appIdentity))
    || (existsSync(expectedWorkRoot) && !sameIdentity(expectedWorkRoot, journal.workIdentity))
    || (existsSync(journal.stagedSibling) && (journal.phase !== "staged" && journal.phase !== "completed"
      || !journal.stagedIdentity || !sameIdentity(journal.stagedSibling, journal.stagedIdentity)))) {
    throw new Error("Direct update cutover or payload identity requires manual reconciliation");
  }
  // No prior bundle was moved, and the live bundle is the same inode. The
  // preparation and staged copy have no recovery role after interruption.
  rmSync(journal.stagedSibling, {recursive:true, force:true});
  rmSync(expectedWorkRoot, {recursive:true, force:true});
  unlinkSync(file);
}
async function performDirectOfficialUpdateOwned(input: DirectOfficialUpdateInput, deps: DirectOfficialUpdateDeps): Promise<{marketingVersion:string|null;build:string|null}> {
  const artifactRoot = (deps.artifactRoot ?? canonicalTweakersManagerRoot)();
  const appPath = input.selection.selectedDesktopPath;
  assertLocalExecutionPath(appPath);
  reconcileDirectOfficialUpdateDebris(artifactRoot, appPath, input.workRoot, deps.signatureInfo ?? signatureInfo);
  // Single-owner under the lifecycle lock: stale debris from crashed runs is
  // ours to clear, and multi-GB partials must never accumulate.
  const workRoot = join(input.workRoot, `direct-${process.pid}`);
  const stagedSibling = `${appPath}.tweakers-direct-staged`;
  const previousSibling = `${appPath}.tweakers-direct-previous`;
  mkdirSync(input.workRoot, {recursive:true, mode:0o700});
  const appStat = lstatSync(appPath), workStat = lstatSync(input.workRoot);
  const journal: DirectUpdateJournal = {version:1, appPath, workRoot:input.workRoot, stagedSibling, previousSibling, latest:input.latest,
    appIdentity:{dev:appStat.dev,ino:appStat.ino}, workIdentity:{dev:workStat.dev,ino:workStat.ino}, phase:"preparing"};
  const publishJournal = () => writeDoctorPrivateJson(directJournalPath(artifactRoot), journal);
  publishJournal();
  let safeToClean = true;
  try {
    const verified = await prepareOfficialUpdateSource({ ...input, workRoot }, deps);
    if (input.shouldAbort?.() === true) {
      throw new Error("Direct update aborted before touching the live app");
    }

    // Stage the verified bundle NEXT TO the destination so the cutover is a
    // pair of same-volume renames, then quit-swap-reopen with a guaranteed
    // reopen on every failure path past the quit.
    // The previous sibling is the existing official app moved by rename, not
    // another staged generation. The direct-update journal retains its recovery
    // ownership; only the downloaded candidate consumes a new artifact slot.
    moveReservedLocalArtifact(artifactRoot, verified, stagedSibling, [], deps.installedTweakersPath?.() ?? "/Applications/Tweakers.app");
    assertVerifiedOfficialBundle(stagedSibling, input, deps);
    const stagedStat = lstatSync(stagedSibling);
    journal.stagedIdentity = {dev:stagedStat.dev,ino:stagedStat.ino};
    journal.phase = "staged"; publishJournal();

    const quit = deps.quitApp ?? quitCodex;
    const running = deps.isAppRunning ?? isCodexMainProcessRunning;
    const open = deps.openApp ?? ((path: string) => openCodex(path, { detached: true }));
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    // The staging clone and its re-verification above take tens of seconds
    // on a multi-GB bundle; a cancel landing in that window must stop the
    // quit itself, not merely the later swap.
    if (input.shouldAbort?.() === true) {
      throw new Error("Direct update aborted before touching the live app");
    }
    quit(appPath);
    try {
      for (let attempt = 0; running(appPath); attempt += 1) {
        if (attempt >= QUIT_SETTLE_ATTEMPTS) {
          throw new Error("The official desktop did not quit for the direct update");
        }
        await sleep(QUIT_SETTLE_INTERVAL_MS);
      }

      // Sparkle's install-on-quit may have finished the job the moment the
      // app exited. A disk version at (or past) the target wins outright.
      const settled = readBundleIdentity(appPath);
      if (settled.build === input.latest.build
        && settled.marketingVersion === input.latest.marketingVersion) {
        return settled;
      }

      if (input.shouldAbort?.() === true) {
        throw new Error("Direct update aborted before the swap");
      }

      renameSync(appPath, previousSibling);
      safeToClean = false;
      journal.phase = "cutover"; publishJournal();
      try {
        renameSync(stagedSibling, appPath);
      } catch (error) {
        renameSync(previousSibling, appPath);
        safeToClean = true;
        throw error;
      }
      const promoted = readBundleIdentity(appPath);
      const signature = (deps.signatureInfo ?? signatureInfo)(appPath);
      if (promoted.build !== input.latest.build
        || !signature.ok || signature.adHoc || signature.teamIdentifier !== OPENAI_TEAM_ID) {
        // Roll the previous official back rather than leave an unproven swap.
        rmSync(appPath, { recursive: true, force: true });
        renameSync(previousSibling, appPath);
        safeToClean = true;
        throw new Error("Direct update swap did not verify; the previous official app was restored");
      }
      journal.phase = "completed"; publishJournal();
      rmSync(previousSibling, { recursive: true, force: true });
      safeToClean = true;
      return promoted;
    } finally {
      // The desktop must never be left closed: reopen whatever bundle is at
      // the live path, on success and on every failure past the quit alike.
      try {
        open(appPath);
      } catch {
        // Reopen is best-effort; the bundle at appPath is always launchable.
      }
    }
  } finally {
    if (safeToClean && !existsSync(previousSibling) && !hasUnreconciledFailedSource(artifactRoot,input.workRoot)) {
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(stagedSibling, { recursive: true, force: true });
      rmSync(input.workRoot, { recursive: true, force: true });
      rmSync(directJournalPath(artifactRoot), {force:true});
    }
    for (const reservation of readReservations(artifactRoot)) {
      if (reservation.state !== "retired" && reservation.paths.some(path => path === stagedSibling || path === previousSibling || path.startsWith(workRoot + "/")) && !reservation.paths.some(existsSync)) {
        releaseEmptyLocalArtifactReservation(artifactRoot, reservation.id);
      }
    }
  }
}

function readBundleIdentity(appPath: string): { marketingVersion: string | null; build: string | null } {
  try {
    const plist = readPlist(join(appPath, "Contents", "Info.plist"));
    return {
      marketingVersion: typeof plist.CFBundleShortVersionString === "string" ? plist.CFBundleShortVersionString : null,
      build: typeof plist.CFBundleVersion === "string" ? plist.CFBundleVersion : null,
    };
  } catch {
    return { marketingVersion: null, build: null };
  }
}

function assertVerifiedOfficialBundle(
  staged: string,
  input: DirectOfficialUpdateInput,
  deps: DirectOfficialUpdateDeps,
): void {
  const plist = readPlist(join(staged, "Contents", "Info.plist"));
  if (plist.CFBundleIdentifier !== input.selection.selectedDesktopBundleId) {
    throw new Error("Direct update bundle identifier does not match the selected desktop");
  }
  if (plist.CFBundleShortVersionString !== input.latest.marketingVersion
    || plist.CFBundleVersion !== input.latest.build) {
    throw new Error("Direct update bundle version does not match the signed appcast item");
  }
  const verifyDeep = deps.verifySignature ?? verifySignature;
  if (!verifyDeep(staged).ok) {
    throw new Error("Direct update bundle failed strict deep signature verification");
  }
  const signature = (deps.signatureInfo ?? signatureInfo)(staged);
  if (!signature.ok || signature.adHoc || signature.teamIdentifier !== OPENAI_TEAM_ID) {
    throw new Error(`Direct update bundle is not signed by OpenAI Team ${OPENAI_TEAM_ID}`);
  }
  const gatekeeper = deps.assessGatekeeper ?? ((appPath: string) => {
    const result = spawnSync("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath], { encoding: "utf8" });
    return result.status === 0;
  });
  if (!gatekeeper(staged)) {
    throw new Error("Direct update bundle failed Gatekeeper assessment");
  }
}

function locateSingleApp(extracted: string): string {
  const apps = readdirSync(extracted, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(extracted, entry.name));
  if (apps.length !== 1) {
    throw new Error(`Direct update archive must contain exactly one app bundle (found ${apps.length})`);
  }
  return apps[0]!;
}

function assertBoundedExtraction(extracted: string, archiveBytes: number): void {
  const limit = Math.min(
    Math.max(archiveBytes, 1) * EXTRACTION_INFLATION_LIMIT + 64 * 1024 * 1024,
    DIRECT_UPDATE_HARD_BYTE_LIMIT * 2,
  );
  let total = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      total += Number(stat.size);
      if (total > limit) throw new Error("Direct update archive extraction exceeds the size bound");
      if (stat.isDirectory()) visit(path);
    }
  };
  visit(extracted);
}

function boundedLimit(enclosureLength: number | null): number {
  if (enclosureLength !== null && Number.isFinite(enclosureLength) && enclosureLength > 0) {
    return Math.min(Math.round(enclosureLength * 1.2) + 16 * 1024 * 1024, DIRECT_UPDATE_HARD_BYTE_LIMIT);
  }
  return DIRECT_UPDATE_HARD_BYTE_LIMIT;
}

function spawnChecked(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "").trim().slice(0, 400)}`);
  }
}

async function downloadBounded(
  url: string,
  destination: string,
  maxBytes: number,
  fetcher: typeof fetch,
): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    // Manual redirects: EVERY hop must be HTTPS, exactly like the appcast
    // probe. redirect:"follow" would silently accept an HTTPS->HTTP downgrade.
    let current = requireHttpsUrl(url);
    let response: Awaited<ReturnType<typeof fetcher>> | null = null;
    for (let redirects = 0; ; redirects += 1) {
      response = await fetcher(current, { signal: controller.signal, redirect: "manual" });
      if (isRedirectStatus(response.status)) {
        if (redirects >= MAX_REDIRECTS) throw new Error("Direct update download followed too many redirects");
        const location = response.headers.get("location");
        if (!location) throw new Error("Direct update redirect is missing its location");
        current = requireHttpsUrl(new URL(location, current).toString());
        continue;
      }
      break;
    }
    if (!response.ok || response.body === null) {
      throw new Error(`Direct update download failed with status ${response.status}`);
    }
    const announced = Number(response.headers.get("content-length"));
    if (Number.isFinite(announced) && announced > maxBytes) {
      throw new Error("Direct update archive exceeds the size bound");
    }

    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const reader = response.body.getReader();
    const stream = createWriteStream(destination, { mode: 0o600 });
    // Capture stream errors as a rejected promise instead of an unhandled
    // 'error' event: a mid-write fs failure must fail this download, never
    // crash the updater process.
    let failStream: (error: Error) => void = () => {};
    const streamFailure = new Promise<never>((_, reject) => { failStream = reject; });
    stream.on("error", (error) => failStream(error));
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), streamFailure]);
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) throw new Error("Direct update archive exceeds the size bound");
        if (!stream.write(value)) {
          await Promise.race([
            new Promise<void>((resolve) => stream.once("drain", resolve)),
            streamFailure,
          ]);
        }
      }
      await Promise.race([
        new Promise<void>((resolve) => stream.end(() => resolve())),
        streamFailure,
      ]);
      return received;
    } catch (error) {
      stream.destroy();
      rmSync(destination, { force: true });
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function requireHttpsUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error("Direct update transport must be HTTPS");
  return parsed.toString();
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

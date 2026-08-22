import { spawnSync } from "node:child_process";
import { createWriteStream, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCodexMainProcessRunning, openCodex, quitCodex } from "./alerts.js";
import { signatureInfo, verifySignature } from "./codesign.js";
import { cloneOrCopyDirectoryPreservingModes } from "./fs-copy.js";
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
}

export interface DirectOfficialUpdateDeps {
  fetch?: typeof fetch;
  execFileSync?: (command: string, args: string[]) => void;
  verifySignature?: typeof verifySignature;
  signatureInfo?: typeof signatureInfo;
  assessGatekeeper?: (appPath: string) => boolean;
  quitApp?: (appPath: string) => void;
  isAppRunning?: (appPath: string) => boolean;
  openApp?: (appPath: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Consulted between download/verify and the quit, and again before the swap. */
  shouldAbort?: () => boolean;
}

export async function performDirectOfficialUpdate(
  input: DirectOfficialUpdateInput,
  deps: DirectOfficialUpdateDeps = {},
): Promise<{ marketingVersion: string | null; build: string | null }> {
  const appPath = input.selection.selectedDesktopPath;
  // Single-owner under the lifecycle lock: stale debris from crashed runs is
  // ours to clear, and multi-GB partials must never accumulate.
  rmSync(input.workRoot, { recursive: true, force: true });
  const workRoot = join(input.workRoot, `direct-${process.pid}`);
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const stagedSibling = `${appPath}.tweakers-direct-staged`;
  const previousSibling = `${appPath}.tweakers-direct-previous`;
  try {
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

    const extracted = join(workRoot, "extracted");
    mkdirSync(extracted, { recursive: true, mode: 0o700 });
    // ditto is the macOS-blessed extractor for signed app archives: it
    // preserves resource forks, xattrs, and symlinks exactly as signed.
    (deps.execFileSync ?? spawnChecked)("ditto", ["-x", "-k", archive, extracted]);
    assertBoundedExtraction(extracted, archiveBytes);
    const verified = locateSingleApp(extracted);
    assertVerifiedOfficialBundle(verified, input, deps);

    if (deps.shouldAbort?.() === true) {
      throw new Error("Direct update aborted before touching the live app");
    }

    // Stage the verified bundle NEXT TO the destination so the cutover is a
    // pair of same-volume renames, then quit-swap-reopen with a guaranteed
    // reopen on every failure path past the quit.
    rmSync(stagedSibling, { recursive: true, force: true });
    rmSync(previousSibling, { recursive: true, force: true });
    cloneOrCopyDirectoryPreservingModes(verified, stagedSibling);
    assertVerifiedOfficialBundle(stagedSibling, input, deps);

    const quit = deps.quitApp ?? quitCodex;
    const running = deps.isAppRunning ?? isCodexMainProcessRunning;
    const open = deps.openApp ?? ((path: string) => openCodex(path, { detached: true }));
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

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

      if (deps.shouldAbort?.() === true) {
        throw new Error("Direct update aborted before the swap");
      }

      renameSync(appPath, previousSibling);
      try {
        renameSync(stagedSibling, appPath);
      } catch (error) {
        renameSync(previousSibling, appPath);
        throw error;
      }
      const promoted = readBundleIdentity(appPath);
      const signature = (deps.signatureInfo ?? signatureInfo)(appPath);
      if (promoted.build !== input.latest.build
        || !signature.ok || signature.adHoc || signature.teamIdentifier !== OPENAI_TEAM_ID) {
        // Roll the previous official back rather than leave an unproven swap.
        rmSync(appPath, { recursive: true, force: true });
        renameSync(previousSibling, appPath);
        throw new Error("Direct update swap did not verify; the previous official app was restored");
      }
      rmSync(previousSibling, { recursive: true, force: true });
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
    rmSync(workRoot, { recursive: true, force: true });
    rmSync(stagedSibling, { recursive: true, force: true });
    rmSync(input.workRoot, { recursive: true, force: true });
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
    const result = spawnSync("spctl", ["--assess", "--type", "execute", appPath], { encoding: "utf8" });
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

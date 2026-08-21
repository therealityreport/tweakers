import { spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isCodexMainProcessRunning, openCodex, quitCodex } from "./alerts.js";
import { signatureInfo, verifySignature } from "./codesign.js";
import { replaceAppBundlePreservingIdentity } from "./commands/install.js";
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
 * unattended anyway: download the release archive named by the SIGNED HTTPS
 * appcast, verify the extracted bundle with the exact trust chain the
 * environment validators already require - strict deep codesign, Developer ID
 * (never ad-hoc), the OpenAI team identifier, Gatekeeper assessment, the
 * expected bundle identity, and the exact advertised version/build - then
 * swap it in atomically and reopen. Any failed check throws before the live
 * app is touched; callers treat a throw as "fall back to the native flow".
 */

export const DIRECT_UPDATE_HARD_BYTE_LIMIT = 3 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const QUIT_SETTLE_ATTEMPTS = 30;
const QUIT_SETTLE_INTERVAL_MS = 1_000;

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
  replaceApp?: typeof replaceAppBundlePreservingIdentity;
  sleep?: (ms: number) => Promise<void>;
}

export async function performDirectOfficialUpdate(
  input: DirectOfficialUpdateInput,
  deps: DirectOfficialUpdateDeps = {},
): Promise<{ marketingVersion: string | null; build: string | null }> {
  const appPath = input.selection.selectedDesktopPath;
  const workRoot = join(input.workRoot, `direct-${process.pid}-${Date.now()}`);
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  try {
    const archive = join(workRoot, "official-update.zip");
    await downloadBounded(input.enclosureUrl, archive, boundedLimit(input.enclosureLength), deps.fetch ?? fetch);

    const extracted = join(workRoot, "extracted");
    mkdirSync(extracted, { recursive: true, mode: 0o700 });
    // ditto is the macOS-blessed extractor for signed app archives: it
    // preserves resource forks, xattrs, and symlinks exactly as signed.
    (deps.execFileSync ?? ((command: string, args: string[]) => {
      spawnUnchecked(command, args);
    }))("ditto", ["-x", "-k", archive, extracted]);
    const staged = locateSingleApp(extracted);

    assertVerifiedOfficialBundle(staged, input, deps);

    const quit = deps.quitApp ?? quitCodex;
    const running = deps.isAppRunning ?? isCodexMainProcessRunning;
    quit(appPath);
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; running(appPath); attempt += 1) {
      if (attempt >= QUIT_SETTLE_ATTEMPTS) {
        throw new Error("The official desktop did not quit for the direct update");
      }
      await sleep(QUIT_SETTLE_INTERVAL_MS);
    }

    const replace = deps.replaceApp ?? replaceAppBundlePreservingIdentity;
    const verifyDeep = deps.verifySignature ?? verifySignature;
    const readSignature = deps.signatureInfo ?? signatureInfo;
    replace(staged, appPath, {
      validateDestination: (promotedRoot) => {
        const signature = readSignature(promotedRoot);
        return verifyDeep(promotedRoot).ok
          && signature.ok
          && !signature.adHoc
          && signature.teamIdentifier === OPENAI_TEAM_ID;
      },
    });

    (deps.openApp ?? ((path: string) => openCodex(path, { detached: true })))(appPath);
    const identity = readPlist(join(appPath, "Contents", "Info.plist"));
    return {
      marketingVersion: typeof identity.CFBundleShortVersionString === "string" ? identity.CFBundleShortVersionString : null,
      build: typeof identity.CFBundleVersion === "string" ? identity.CFBundleVersion : null,
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
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

function boundedLimit(enclosureLength: number | null): number {
  if (enclosureLength !== null && Number.isFinite(enclosureLength) && enclosureLength > 0) {
    return Math.min(Math.round(enclosureLength * 1.2) + 16 * 1024 * 1024, DIRECT_UPDATE_HARD_BYTE_LIMIT);
  }
  return DIRECT_UPDATE_HARD_BYTE_LIMIT;
}

function spawnUnchecked(command: string, args: string[]): void {
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
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Direct update transport must be HTTPS");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetcher(parsed.toString(), { signal: controller.signal, redirect: "follow" });
    if (!response.ok || response.body === null) {
      throw new Error(`Direct update download failed with status ${response.status}`);
    }
    const announced = Number(response.headers.get("content-length"));
    if (Number.isFinite(announced) && announced > maxBytes) {
      throw new Error("Direct update archive exceeds the size bound");
    }
    const reader = response.body.getReader();
    const stream = createWriteStream(destination, { mode: 0o600 });
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) throw new Error("Direct update archive exceeds the size bound");
        if (!stream.write(value)) {
          await new Promise<void>((resolve, reject) => {
            stream.once("drain", resolve);
            stream.once("error", reject);
          });
        }
      }
      await new Promise<void>((resolve, reject) => {
        stream.end(() => resolve());
        stream.once("error", reject);
      });
    } catch (error) {
      stream.destroy();
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

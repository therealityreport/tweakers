import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readPlist, writePlist, type Plist } from "./plist.js";

export const OPENAI_TEAM_ID = "2DC432GLL2";
export const TWEAKERS_VARIANT_BUNDLE_ID = "com.therealityreport.tweakers.chatgpt";
export const TWEAKERS_VARIANT_NAME = "Tweakers ChatGPT";
export const TWEAKERS_VARIANT_URL_SCHEME = "tweakers-chatgpt";

export interface MacAppIdentity {
  bundleId: string;
  displayName: string;
  urlScheme: string;
  appUserDataRoot: string;
}

export function defaultTweakersVariantIdentity(appUserDataRoot: string): MacAppIdentity {
  return {
    bundleId: TWEAKERS_VARIANT_BUNDLE_ID,
    displayName: TWEAKERS_VARIANT_NAME,
    urlScheme: TWEAKERS_VARIANT_URL_SCHEME,
    appUserDataRoot,
  };
}

/**
 * Give a locally signed Tweakers copy its own LaunchServices identity. The
 * official OpenAI app must keep com.openai.codex and its original signature.
 */
export function applyMacAppIdentity(appRoot: string, identity: MacAppIdentity): string[] {
  const mainInfo = join(appRoot, "Contents", "Info.plist");
  if (!existsSync(mainInfo)) throw new Error(`Variant app is missing Info.plist: ${mainInfo}`);

  const changed: string[] = [];
  for (const path of collectInfoPlists(join(appRoot, "Contents"))) {
    const value = readPlist(path);
    let dirty = false;
    const currentBundleId = typeof value.CFBundleIdentifier === "string" ? value.CFBundleIdentifier : null;
    if (path === mainInfo) {
      dirty = setValue(value, "CFBundleIdentifier", identity.bundleId) || dirty;
      dirty = setValue(value, "CFBundleName", identity.displayName) || dirty;
      dirty = setValue(value, "CFBundleDisplayName", identity.displayName) || dirty;
      dirty = setValue(value, "CFBundleURLTypes", [{
        CFBundleURLName: identity.displayName,
        CFBundleURLSchemes: [identity.urlScheme],
      }]) || dirty;
      // A variant is refreshed by Tweakers from a verified official source; it
      // must never let Sparkle overwrite itself or contend with the official app.
      dirty = setValue(value, "SUEnableAutomaticChecks", false) || dirty;
      dirty = setValue(value, "SUAutomaticallyUpdate", false) || dirty;
    } else if (currentBundleId?.startsWith("com.openai.codex")) {
      dirty = setValue(
        value,
        "CFBundleIdentifier",
        identity.bundleId + currentBundleId.slice("com.openai.codex".length),
      ) || dirty;
    }
    if (dirty) {
      writePlist(path, value);
      changed.push(path);
    }
  }
  return changed;
}

function collectInfoPlists(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "Info.plist") out.push(path);
    }
  };
  visit(root);
  return out.sort();
}

function setValue(plist: Plist, key: string, value: unknown): boolean {
  if (JSON.stringify(plist[key]) === JSON.stringify(value)) return false;
  plist[key] = value;
  return true;
}

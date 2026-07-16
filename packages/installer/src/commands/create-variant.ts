import kleur from "kleur";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { signatureInfo, verifySignature } from "../codesign.js";
import { install } from "./install.js";
import { cloneAppTree } from "../transaction.js";
import { readPlist } from "../plist.js";
import {
  OPENAI_TEAM_ID,
  TWEAKERS_VARIANT_BUNDLE_ID,
  TWEAKERS_VARIANT_NAME,
  defaultTweakersVariantIdentity,
} from "../macos-variant.js";

export interface CreateVariantOptions {
  source?: string;
  app?: string;
  userRoot?: string;
  "user-root"?: string;
  userData?: string;
  "user-data"?: string;
}

interface CreateVariantDeps {
  platform?: () => NodeJS.Platform;
  home?: () => string;
  cloneApp?: typeof cloneAppTree;
  installApp?: typeof install;
  signature?: typeof signatureInfo;
  verify?: typeof verifySignature;
  removeApp?: (path: string) => void;
}

export async function createTweakersVariant(
  options: CreateVariantOptions = {},
  deps: CreateVariantDeps = {},
): Promise<void> {
  if ((deps.platform ?? platform)() !== "darwin") {
    throw new Error("A separate Tweakers ChatGPT app is currently supported only on macOS.");
  }

  const source = resolve(options.source ?? "/Applications/ChatGPT.app");
  const target = resolve(options.app ?? "/Applications/Tweakers ChatGPT.app");
  const userRoot = resolve(
    options.userRoot
      ?? options["user-root"]
      ?? join(homedir(), "Library", "Application Support", "Tweakers", "variants", "chatgpt"),
  );
  const appUserDataRoot = resolve(
    options.userData
      ?? options["user-data"]
      ?? join(userRoot, "app-data"),
  );

  if (source === target) throw new Error("The Tweakers variant target must differ from the official source app.");
  if (target === "/Applications/ChatGPT.app") {
    throw new Error(
      "Refusing to create a variant at /Applications/ChatGPT.app. The official app path is managed by the mode toggle — use `tweakers mode tweakers` to patch it and `tweakers mode chatgpt` to restore the pristine app.",
    );
  }
  if (!target.endsWith(".app")) throw new Error("The Tweakers variant target must be a macOS .app bundle.");
  if (!existsSync(source)) throw new Error(`Official ChatGPT source not found: ${source}`);
  if (existsSync(target)) throw new Error(`Variant target already exists: ${target}`);

  const signature = (deps.signature ?? signatureInfo)(source);
  const verified = (deps.verify ?? verifySignature)(source);
  if (
    !signature.ok
    || signature.adHoc
    || signature.teamIdentifier !== OPENAI_TEAM_ID
    || !signature.authority.some((authority) => authority.includes("OpenAI"))
    || !verified.ok
  ) {
    throw new Error(
      `Refusing non-official source. Expected a valid OpenAI Developer ID signature with team ${OPENAI_TEAM_ID}.`,
    );
  }

  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(appUserDataRoot, { recursive: true });
  // The owl Electron fork derives userData natively from the asar productName
  // ("Tweakers ChatGPT" for a variant) before any JS can call setPath, so that
  // native location must resolve to the isolated app-data root.
  const nativeUserDataLink = linkNativeUserData(appUserDataRoot, (deps.home ?? homedir)());

  const previousHome = process.env.TWEAKERS_HOME;
  process.env.TWEAKERS_HOME = userRoot;
  try {
    (deps.cloneApp ?? cloneAppTree)(source, target);
    await (deps.installApp ?? install)({
      app: target,
      watcher: false,
      localSigning: true,
      macAppIdentity: defaultTweakersVariantIdentity(appUserDataRoot),
    });
    verifyCreatedVariant(target, userRoot, deps);
  } catch (error) {
    (deps.removeApp ?? ((path) => rmSync(path, { recursive: true, force: true })))(target);
    if (nativeUserDataLink.created) unlinkSync(nativeUserDataLink.path);
    throw error;
  } finally {
    if (previousHome === undefined) delete process.env.TWEAKERS_HOME;
    else process.env.TWEAKERS_HOME = previousHome;
  }

  console.log(kleur.green().bold("✓ Separate Tweakers ChatGPT app created."));
  console.log(`  App:      ${kleur.cyan(target)}`);
  console.log(`  State:    ${kleur.cyan(userRoot)}`);
  console.log(`  App data: ${kleur.cyan(appUserDataRoot)}`);
  console.log("  Watcher:  disabled (the official ChatGPT app remains untouched)");
}

function linkNativeUserData(appUserDataRoot: string, home: string): { created: boolean; path: string } {
  const nativeUserData = join(home, "Library", "Application Support", TWEAKERS_VARIANT_NAME);
  mkdirSync(dirname(nativeUserData), { recursive: true });
  if (!existsSync(nativeUserData) && !isSymlink(nativeUserData)) {
    symlinkSync(appUserDataRoot, nativeUserData);
    return { created: true, path: nativeUserData };
  }
  if (isSymlink(nativeUserData) && resolve(readlinkSync(nativeUserData)) === resolve(appUserDataRoot)) {
    return { created: false, path: nativeUserData };
  }
  throw new Error(
    `Native user-data path already exists and does not point at the isolated app-data root: ${nativeUserData}`,
  );
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function verifyCreatedVariant(target: string, userRoot: string, deps: CreateVariantDeps): void {
  const verified = (deps.verify ?? verifySignature)(target);
  if (!verified.ok) throw new Error(`Created variant failed signature verification: ${verified.output}`);
  const plist = readPlist(join(target, "Contents", "Info.plist"));
  if (plist.CFBundleIdentifier !== TWEAKERS_VARIANT_BUNDLE_ID) {
    throw new Error("Created variant did not receive the isolated Tweakers bundle identifier.");
  }
  const state = JSON.parse(readFileSync(join(userRoot, "state.json"), "utf8")) as {
    appRoot?: unknown;
    watcher?: unknown;
  };
  if (resolve(String(state.appRoot ?? "")) !== target || state.watcher !== "none") {
    throw new Error("Created variant state is not isolated or unexpectedly owns a watcher.");
  }
}

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPlist, writePlist } from "../src/plist";
import {
  TWEAKERS_VARIANT_BUNDLE_ID,
  applyMacAppIdentity,
  defaultTweakersVariantIdentity,
} from "../src/macos-variant";
import { createTweakersVariant } from "../src/commands/create-variant";

test("applyMacAppIdentity isolates main and OpenAI helper identities", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-"));
  try {
    const app = join(root, "Tweakers ChatGPT.app");
    const main = join(app, "Contents", "Info.plist");
    const helper = join(app, "Contents", "Frameworks", "Codex Helper.app", "Contents", "Info.plist");
    mkdirSync(join(app, "Contents", "Frameworks", "Codex Helper.app", "Contents"), { recursive: true });
    writePlist(main, {
      CFBundleIdentifier: "com.openai.codex",
      CFBundleName: "ChatGPT",
      CFBundleDisplayName: "ChatGPT",
      CFBundleURLTypes: [{ CFBundleURLName: "ChatGPT", CFBundleURLSchemes: ["codex"] }],
    });
    writePlist(helper, { CFBundleIdentifier: "com.openai.codex.helper.renderer" });

    const changed = applyMacAppIdentity(app, defaultTweakersVariantIdentity(join(root, "user-data")));
    assert.equal(changed.length, 2);
    const mainValue = readPlist(main);
    assert.equal(mainValue.CFBundleIdentifier, TWEAKERS_VARIANT_BUNDLE_ID);
    assert.equal(mainValue.CFBundleDisplayName, "Tweakers ChatGPT");
    assert.deepEqual(mainValue.CFBundleURLTypes, [{
      CFBundleURLName: "Tweakers ChatGPT",
      CFBundleURLSchemes: ["tweakers-chatgpt"],
    }]);
    assert.equal(mainValue.SUEnableAutomaticChecks, false);
    assert.equal(readPlist(helper).CFBundleIdentifier, `${TWEAKERS_VARIANT_BUNDLE_ID}.helper.renderer`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createTweakersVariant refuses a source without the OpenAI team identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-"));
  try {
    const source = join(root, "ChatGPT.app");
    mkdirSync(source, { recursive: true });
    await assert.rejects(
      createTweakersVariant({ source, app: join(root, "Variant.app") }, {
        platform: () => "darwin",
        signature: () => ({ ok: true, adHoc: false, teamIdentifier: "WRONG", authority: ["OpenAI"], output: "" }),
        verify: () => ({ ok: true, output: "" }),
      }),
      /Expected a valid OpenAI Developer ID signature/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createTweakersVariant enforces isolated state and disables the watcher", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-"));
  const source = join(root, "ChatGPT.app");
  const target = join(root, "Tweakers ChatGPT.app");
  const userRoot = join(root, "state");
  try {
    mkdirSync(join(source, "Contents"), { recursive: true });
    writePlist(join(source, "Contents", "Info.plist"), { CFBundleIdentifier: "com.openai.codex" });
    let observedHome: string | undefined;
    await createTweakersVariant({ source, app: target, userRoot }, {
      platform: () => "darwin",
      home: () => root,
      signature: () => ({
        ok: true,
        adHoc: false,
        teamIdentifier: "2DC432GLL2",
        authority: ["Developer ID Application: OpenAI, L.L.C. (2DC432GLL2)"],
        output: "",
      }),
      verify: () => ({ ok: true, output: "" }),
      cloneApp: (from, to) => {
        mkdirSync(join(to, "Contents"), { recursive: true });
        writeFileSync(join(to, "Contents", "Info.plist"), readFileSync(join(from, "Contents", "Info.plist")));
      },
      installApp: async (opts) => {
        observedHome = process.env.TWEAKERS_HOME;
        assert.equal(opts.watcher, false);
        assert.equal(opts.macAppIdentity?.bundleId, TWEAKERS_VARIANT_BUNDLE_ID);
        writePlist(join(target, "Contents", "Info.plist"), { CFBundleIdentifier: TWEAKERS_VARIANT_BUNDLE_ID });
        writeFileSync(join(userRoot, "state.json"), JSON.stringify({ appRoot: target, watcher: "none" }));
      },
    });
    assert.equal(observedHome, userRoot);
    assert.notEqual(process.env.TWEAKERS_HOME, userRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createTweakersVariant removes its native user-data link when installation fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-"));
  const source = join(root, "ChatGPT.app");
  const target = join(root, "Tweakers ChatGPT.app");
  const userRoot = join(root, "state");
  const nativeLink = join(root, "Library", "Application Support", "Tweakers ChatGPT");
  try {
    mkdirSync(source, { recursive: true });
    await assert.rejects(
      createTweakersVariant({ source, app: target, userRoot }, {
        platform: () => "darwin",
        home: () => root,
        signature: () => ({
          ok: true,
          adHoc: false,
          teamIdentifier: "2DC432GLL2",
          authority: ["Developer ID Application: OpenAI, L.L.C. (2DC432GLL2)"],
          output: "",
        }),
        verify: () => ({ ok: true, output: "" }),
        cloneApp: (_from, to) => mkdirSync(to, { recursive: true }),
        installApp: async () => { throw new Error("simulated install failure"); },
      }),
      /simulated install failure/,
    );
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(nativeLink), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPlist, writePlist } from "../src/plist";
import {
  TWEAKERS_VARIANT_BUNDLE_ID,
  TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG,
  TWEAKERS_VARIANT_CODEX_HOME_CONFIG,
  TWEAKERS_VARIANT_COMPUTER_USE_BUNDLE_ID,
  TWEAKERS_VARIANT_DOCK_ICON_FILES,
  TWEAKERS_VARIANT_ICON_FILE,
  TWEAKERS_VARIANT_ICON_SOURCE,
  TWEAKERS_VARIANT_PNG_SOURCE,
  TWEAKERS_VARIANT_PRODUCT_NAME,
  TWEAKERS_VARIANT_USER_DATA_CONFIG,
  TWEAKERS_ORIGINAL_EXECUTABLE,
  applyMacAppIdentity,
  defaultTweakersAccountsBrokerRoot,
  defaultTweakersVariantIdentity,
  installMacAppLauncher,
} from "../src/macos-variant";
import { createTweakersVariant, refreshTweakersVariant } from "../src/commands/create-variant";
import type { MacAppIdentity } from "../src/macos-variant";
import type { UserPaths } from "../src/paths";
import { routerConfigFingerprint } from "../../runtime/src/account-router/config";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfigV3 } from "../../runtime/src/account-router/types";

function registerFixtureAccounts(home: string): void {
  const root = defaultTweakersAccountsBrokerRoot(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const config: RouterConfigV3 = {
    schemaVersion: 3, mode: "quota_aware", policy: "quota_aware_v2", generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: `ar_${"a".repeat(43)}`,
    accounts: [{ opaqueAccountId: `ar_${"a".repeat(43)}`, included: true, weight: 1, label: "Account",
      capabilityFingerprint: `sha256:${"b".repeat(64)}` }],
    updatedAt: "2026-09-05T00:00:00.000Z", fingerprint: `sha256:${"0".repeat(64)}`,
  };
  config.fingerprint = routerConfigFingerprint(config);
  writeFileSync(join(root, "account-router-config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(root, "control-secret.v1"), Buffer.alloc(32, 17), { mode: 0o600 });
}

const bundledIds = [
  "co.tweakers.account-switcher", "co.tweakers.appshots", "co.tweakers.developer-tools",
  "co.tweakers.followup", "co.tweakers.projects", "co.tweakers.shadcn-codex-ui",
  "co.tweakers.thread-summary-profiles", "co.tweakers.titlebar-controls",
  "co.tweakers.ui-improvements", "co.tweakers.usage-limit-resets-tracker",
  "co.tweakers.user-questions",
];

function stageBundledFixture(root: string): void {
  for (const id of bundledIds) {
    const directory = join(root, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({ id }));
  }
}

interface CandidateInstallOptions {
  app?: string;
  macAppIdentity?: MacAppIdentity;
  candidateContext?: { paths: UserPaths };
}

function installCandidateFixture(opts: CandidateInstallOptions): void {
  const candidate = opts.app!;
  const paths = opts.candidateContext!.paths;
  const identity = opts.macAppIdentity!;
  mkdirSync(paths.runtime, { recursive: true });
  mkdirSync(paths.tweaks, { recursive: true });
  mkdirSync(join(candidate, "Contents", "Resources"), { recursive: true });
  writePlist(join(candidate, "Contents", "Info.plist"), {
    CFBundleIdentifier: TWEAKERS_VARIANT_BUNDLE_ID,
    CFBundleName: "Tweakers",
    CFBundleDisplayName: "Tweakers",
    CFBundleExecutable: "ChatGPT",
    CrProductDirName: TWEAKERS_VARIANT_PRODUCT_NAME,
    BundleSigningBaseName: "Tweakers",
    TweakersOriginalExecutable: TWEAKERS_ORIGINAL_EXECUTABLE,
    LSEnvironment: {
      CODEX_ELECTRON_USER_DATA_PATH: identity.appUserDataRoot,
      CODEX_HOME: identity.codexHomeRoot,
      CODEX_SQLITE_HOME: identity.codexHomeRoot,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
      TWEAKERS_ACCOUNTS_BROKER_ROOT: identity.accountsBrokerRoot,
      TWEAKER_ACCOUNTS_BROKER_ROOT: identity.accountsBrokerRoot,
      TWEAKERS_DERIVED_VARIANT: "1",
    },
    CFBundleIconFile: TWEAKERS_VARIANT_ICON_FILE,
    CFBundleURLTypes: [{ CFBundleURLSchemes: ["tweakers"] }],
    SUEnableAutomaticChecks: false,
    SUAutomaticallyUpdate: false,
  });
  mkdirSync(join(candidate, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(candidate, "Contents", "MacOS", "ChatGPT"), "launcher", { mode: 0o755 });
  writeFileSync(
    join(candidate, "Contents", "MacOS", TWEAKERS_ORIGINAL_EXECUTABLE),
    "electron",
    { mode: 0o755 },
  );
  const launcherConfig = join(candidate, "Contents", "Resources", "tweakers");
  mkdirSync(launcherConfig, { recursive: true, mode: 0o700 });
  for (const [configPath, value] of [
    [TWEAKERS_VARIANT_USER_DATA_CONFIG, identity.appUserDataRoot],
    [TWEAKERS_VARIANT_CODEX_HOME_CONFIG, identity.codexHomeRoot],
    [TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG, identity.accountsBrokerRoot],
  ] as const) {
    writeFileSync(join(candidate, "Contents", "Resources", configPath), `${value}\n`, { mode: 0o600 });
  }
  writeFileSync(join(candidate, "Contents", "Resources", TWEAKERS_VARIANT_ICON_FILE), readFileSync(TWEAKERS_VARIANT_ICON_SOURCE));
  for (const name of TWEAKERS_VARIANT_DOCK_ICON_FILES) {
    writeFileSync(join(candidate, "Contents", "Resources", name), readFileSync(TWEAKERS_VARIANT_PNG_SOURCE));
  }
  writeFileSync(paths.stateFile, JSON.stringify({
    appRoot: candidate,
    watcher: "none",
    signingMode: "local-identity",
    signingIdentity: "Tweakers Local Signing",
  }));
}

function createPromotionFixture(root: string, faultPoint: string): {
  source: string;
  target: string;
  userRoot: string;
  oldState: string;
  oldConfig: string;
  oldAppMarker: string;
  oldRuntimeMarker: string;
  oldTweaksMarker: string;
  deps: Parameters<typeof refreshTweakersVariant>[1];
} {
  registerFixtureAccounts(root);
  const source = join(root, "ChatGPT.app");
  const target = join(root, "Tweakers.app");
  const userRoot = join(root, "state");
  const oldState = `${JSON.stringify({ appRoot: target, watcher: "none", marker: "old-state" })}\n`;
  const oldConfig = `${JSON.stringify({ tweaks: { "co.example.legacy": { enabled: false } }, marker: "old-config" })}\n`;
  const oldAppMarker = "old app";
  const oldRuntimeMarker = "old runtime";
  const oldTweaksMarker = "old tweaks";
  mkdirSync(join(source, "Contents"), { recursive: true });
  writePlist(join(source, "Contents", "Info.plist"), { CFBundleIdentifier: "com.openai.codex" });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "marker"), oldAppMarker);
  mkdirSync(join(userRoot, "runtime"), { recursive: true });
  mkdirSync(join(userRoot, "tweaks"), { recursive: true });
  writeFileSync(join(userRoot, "runtime", "marker"), oldRuntimeMarker);
  writeFileSync(join(userRoot, "tweaks", "marker"), oldTweaksMarker);
  writeFileSync(join(userRoot, "state.json"), oldState);
  writeFileSync(join(userRoot, "config.json"), oldConfig);

  return {
    source,
    target,
    userRoot,
    oldState,
    oldConfig,
    oldAppMarker,
    oldRuntimeMarker,
    oldTweaksMarker,
    deps: {
      platform: () => "darwin",
      home: () => root,
      id: () => "fault-injection",
      signature: () => ({
        ok: true,
        adHoc: false,
        teamIdentifier: "2DC432GLL2",
        authority: ["Developer ID Application: OpenAI, L.L.C. (2DC432GLL2)"],
        output: "",
      }),
      verify: () => ({ ok: true, output: "" }),
      verifyResourceAsarIntegrity: () => {},
      gatekeeper: () => ({ ok: true, output: "accepted" }),
      targetProcessRunning: () => false,
      cloneApp: (_from, to) => mkdirSync(to, { recursive: true }),
      installApp: async (opts) => installCandidateFixture(opts),
      stageTweaks: (tweaks) => stageBundledFixture(tweaks),
      fault: (point) => {
        if (point === faultPoint) throw new Error(`injected filesystem failure at ${point}`);
      },
    },
  };
}

async function assertPromotionRollback(faultPoint: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-promotion-"));
  try {
    const fixture = createPromotionFixture(root, faultPoint);
    await assert.rejects(
      refreshTweakersVariant({ source: fixture.source, app: fixture.target, userRoot: fixture.userRoot }, fixture.deps),
      new RegExp(`injected filesystem failure at ${faultPoint}`),
    );
    assert.equal(readFileSync(join(fixture.target, "marker"), "utf8"), fixture.oldAppMarker, faultPoint);
    assert.equal(readFileSync(join(fixture.userRoot, "runtime", "marker"), "utf8"), fixture.oldRuntimeMarker, faultPoint);
    assert.equal(readFileSync(join(fixture.userRoot, "tweaks", "marker"), "utf8"), fixture.oldTweaksMarker, faultPoint);
    assert.equal(readFileSync(join(fixture.userRoot, "state.json"), "utf8"), fixture.oldState, faultPoint);
    assert.equal(readFileSync(join(fixture.userRoot, "config.json"), "utf8"), fixture.oldConfig, faultPoint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("applyMacAppIdentity isolates main and OpenAI helper identities", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-"));
  try {
    const app = join(root, "Tweakers.app");
    const main = join(app, "Contents", "Info.plist");
    const helper = join(app, "Contents", "Frameworks", "Codex Helper.app", "Contents", "Info.plist");
    const computerUse = join(app, "Contents", "Resources", "Tweakers Computer Use.app", "Contents", "Info.plist");
    mkdirSync(join(app, "Contents", "Frameworks", "Codex Helper.app", "Contents"), { recursive: true });
    mkdirSync(join(app, "Contents", "Resources", "Tweakers Computer Use.app", "Contents"), { recursive: true });
    writePlist(main, {
      CFBundleIdentifier: "com.openai.codex",
      CFBundleName: "ChatGPT",
      CFBundleDisplayName: "ChatGPT",
      CFBundleExecutable: "ChatGPT",
      CFBundleIconName: "Icon",
      CodexAppIconBaseName: "icon-chatgpt",
      NSDockTilePlugIn: "CodexDockTilePlugin.docktileplugin",
      CrProductDirName: "com.openai.codex",
      BundleSigningBaseName: "Codex",
      LSEnvironment: { MallocNanoZone: "0" },
      CFBundleURLTypes: [{ CFBundleURLName: "ChatGPT", CFBundleURLSchemes: ["codex"] }],
    });
    writePlist(helper, { CFBundleIdentifier: "com.openai.codex.helper.renderer" });
    writePlist(computerUse, {
      CFBundleIdentifier: "com.openai.sky.CUAService",
      CFBundleName: "Codex Computer Use",
      CFBundleDisplayName: "Codex Computer Use",
    });
    const launcher = join(root, "tweakers-app-launcher");
    writeFileSync(launcher, "launcher", { mode: 0o755 });
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "MacOS", "ChatGPT"), "electron", { mode: 0o755 });
    const identity = {
      ...defaultTweakersVariantIdentity(
        join(root, "user-data"),
        join(root, "state"),
        join(root, "accounts-broker"),
      ),
      launcherSourcePath: launcher,
    };

    const changed = applyMacAppIdentity(app, identity);
    installMacAppLauncher(app, identity);
    assert.equal(changed.length, 3);
    const mainValue = readPlist(main);
    assert.equal(mainValue.CFBundleIdentifier, TWEAKERS_VARIANT_BUNDLE_ID);
    assert.equal(mainValue.CFBundleDisplayName, "Tweakers");
    assert.equal(mainValue.CrProductDirName, TWEAKERS_VARIANT_PRODUCT_NAME);
    assert.equal(mainValue.BundleSigningBaseName, "Tweakers");
    assert.equal(mainValue.CFBundleIconFile, TWEAKERS_VARIANT_ICON_FILE);
    assert.equal(mainValue.CFBundleIconName, undefined);
    assert.equal(mainValue.CodexAppIconBaseName, undefined);
    assert.equal(mainValue.NSDockTilePlugIn, undefined);
    assert.deepEqual(mainValue.LSEnvironment, {
      MallocNanoZone: "0",
      CODEX_ELECTRON_USER_DATA_PATH: join(root, "user-data"),
      CODEX_HOME: join(root, "state", "codex-home"),
      CODEX_SQLITE_HOME: join(root, "state", "codex-home"),
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
      TWEAKERS_ACCOUNTS_BROKER_ROOT: join(root, "accounts-broker"),
      TWEAKER_ACCOUNTS_BROKER_ROOT: join(root, "accounts-broker"),
      TWEAKERS_DERIVED_VARIANT: "1",
    });
    assert.deepEqual(
      readFileSync(join(app, "Contents", "Resources", TWEAKERS_VARIANT_ICON_FILE)),
      readFileSync(TWEAKERS_VARIANT_ICON_SOURCE),
    );
    for (const name of TWEAKERS_VARIANT_DOCK_ICON_FILES) {
      assert.deepEqual(
        readFileSync(join(app, "Contents", "Resources", name)),
        readFileSync(TWEAKERS_VARIANT_PNG_SOURCE),
      );
    }
    assert.deepEqual(mainValue.CFBundleURLTypes, [{
      CFBundleURLName: "Tweakers",
      CFBundleURLSchemes: ["tweakers"],
    }]);
    assert.equal(mainValue.SUEnableAutomaticChecks, false);
    assert.equal(readPlist(helper).CFBundleIdentifier, `${TWEAKERS_VARIANT_BUNDLE_ID}.helper.renderer`);
    assert.equal(readPlist(computerUse).CFBundleIdentifier, TWEAKERS_VARIANT_COMPUTER_USE_BUNDLE_ID);
    assert.equal(readPlist(computerUse).CFBundleDisplayName, "Tweakers Computer Use");
    assert.equal(readFileSync(join(app, "Contents", "MacOS", TWEAKERS_ORIGINAL_EXECUTABLE), "utf8"), "electron");
    assert.equal(readFileSync(join(app, "Contents", "MacOS", "ChatGPT"), "utf8"), "launcher");
    assert.equal(mainValue.TweakersOriginalExecutable, TWEAKERS_ORIGINAL_EXECUTABLE);
    assert.equal(mainValue.LSAllowOtherExecutablesToCheckIn, true);
    const launcherConfig = join(app, "Contents", "Resources", "tweakers");
    assert.equal(
      readFileSync(join(app, "Contents", "Resources", TWEAKERS_VARIANT_USER_DATA_CONFIG), "utf8"),
      `${identity.appUserDataRoot}\n`,
    );
    assert.equal(
      readFileSync(join(app, "Contents", "Resources", TWEAKERS_VARIANT_CODEX_HOME_CONFIG), "utf8"),
      `${identity.codexHomeRoot}\n`,
    );
    assert.equal(
      readFileSync(join(app, "Contents", "Resources", TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG), "utf8"),
      `${identity.accountsBrokerRoot}\n`,
    );
    assert.equal(lstatSync(launcherConfig).mode & 0o777, 0o700);
    for (const configPath of [
      TWEAKERS_VARIANT_USER_DATA_CONFIG,
      TWEAKERS_VARIANT_CODEX_HOME_CONFIG,
      TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG,
    ]) {
      assert.equal(
        lstatSync(join(app, "Contents", "Resources", configPath)).mode & 0o777,
        0o600,
        configPath,
      );
    }
    assert.doesNotThrow(() => applyMacAppIdentity(app, identity));
    assert.doesNotThrow(() => installMacAppLauncher(app, identity));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installMacAppLauncher rejects unsafe executable, malformed paths, preserved-name collision, and symlinked configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-app-launcher-"));
  try {
    const launcher = join(root, "tweakers-app-launcher");
    writeFileSync(launcher, "launcher", { mode: 0o755 });
    const identity = {
      ...defaultTweakersVariantIdentity(join(root, "user-data"), join(root, "state"), join(root, "broker")),
      launcherSourcePath: launcher,
    };
    const makeApp = (name: string, executable = "ChatGPT"): string => {
      const app = join(root, name);
      mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
      mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
      writePlist(join(app, "Contents", "Info.plist"), { CFBundleExecutable: executable });
      if (executable === "ChatGPT") {
        writeFileSync(join(app, "Contents", "MacOS", executable), "electron", { mode: 0o755 });
      }
      return app;
    };

    const unsafe = makeApp("Unsafe.app", "../ChatGPT");
    assert.throws(() => installMacAppLauncher(unsafe, identity), /CFBundleExecutable must be one safe file name/);

    const malformedPath = makeApp("MalformedPath.app");
    assert.throws(
      () => installMacAppLauncher(malformedPath, { ...identity, appUserDataRoot: `${root}/bad\npath` }),
      /Variant app data path must be exact and absolute/,
    );
    assert.equal(readFileSync(join(malformedPath, "Contents", "MacOS", "ChatGPT"), "utf8"), "electron");

    const collision = makeApp("Collision.app");
    writeFileSync(join(collision, "Contents", "MacOS", TWEAKERS_ORIGINAL_EXECUTABLE), "foreign", { mode: 0o755 });
    assert.throws(() => installMacAppLauncher(collision, identity), /launcher collision/);
    assert.equal(readFileSync(join(collision, "Contents", "MacOS", "ChatGPT"), "utf8"), "electron");

    const symlinkedConfig = makeApp("SymlinkedConfig.app");
    const config = join(symlinkedConfig, "Contents", "Resources", "tweakers");
    const outside = join(root, "outside-config");
    mkdirSync(config, { recursive: true });
    symlinkSync(outside, join(symlinkedConfig, "Contents", "Resources", TWEAKERS_VARIANT_USER_DATA_CONFIG));
    assert.throws(() => installMacAppLauncher(symlinkedConfig, identity), /must be a real regular file/);
    assert.equal(readFileSync(join(symlinkedConfig, "Contents", "MacOS", "ChatGPT"), "utf8"), "electron");
    assert.equal(existsSync(join(symlinkedConfig, "Contents", "MacOS", TWEAKERS_ORIGINAL_EXECUTABLE)), false);
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
      createTweakersVariant({ source, app: join(root, "Variant.app"), userRoot: join(root, "state") }, {
        platform: () => "darwin",
        home: () => root,
        signature: () => ({ ok: true, adHoc: false, teamIdentifier: "WRONG", authority: ["OpenAI"], output: "" }),
        verify: () => ({ ok: true, output: "" }),
      }),
      /Expected a strict-valid, Gatekeeper-accepted OpenAI Developer ID signature/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createTweakersVariant enforces isolated state and disables the watcher", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-"));
  const source = join(root, "ChatGPT.app");
  const target = join(root, "Tweakers.app");
  const userRoot = join(root, "state");
  const managerRoot = join(root, "Library", "Application Support", "Tweakers");
  try {
    registerFixtureAccounts(root);
    mkdirSync(join(source, "Contents"), { recursive: true });
    writePlist(join(source, "Contents", "Info.plist"), { CFBundleIdentifier: "com.openai.codex" });
    let observedHome: string | undefined;
    let publishedManagerRoot: string | undefined;
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
      verifyResourceAsarIntegrity: () => {},
      gatekeeper: () => ({ ok: true, output: "accepted" }),
      targetProcessRunning: () => false,
      bootstrapManagerEnvironment: ({ sourceRoot, destinationRoot }) => ({
        sourceRoot,
        destinationRoot,
        registryFile: join(destinationRoot, "environment-registry.json"),
        selectionFile: join(destinationRoot, "environment-selection.json"),
        bootstrapped: true,
        restoreOnFailure() {},
      }),
      publishManagerDescriptor: ({ userRoot: publishedRoot }) => {
        publishedManagerRoot = publishedRoot;
        return { restoreOnFailure() {} };
      },
      cloneApp: (from, to) => {
        mkdirSync(join(to, "Contents"), { recursive: true });
        mkdirSync(join(to, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(to, "Contents", "Info.plist"), readFileSync(join(from, "Contents", "Info.plist")));
        writeFileSync(
          join(to, "Contents", "Resources", TWEAKERS_VARIANT_ICON_FILE),
          readFileSync(TWEAKERS_VARIANT_ICON_SOURCE),
        );
      },
      stageTweaks: (tweaks) => stageBundledFixture(tweaks),
      installApp: async (opts) => {
        observedHome = process.env.TWEAKERS_HOME;
        assert.equal(opts.watcher, false);
        assert.equal(opts.macAppIdentity?.bundleId, TWEAKERS_VARIANT_BUNDLE_ID);
        assert.equal(opts.macAppIdentity?.productName, TWEAKERS_VARIANT_PRODUCT_NAME);
        assert.equal(opts.macAppIdentity?.codexHomeRoot, join(userRoot, "codex-home"));
        assert.equal(opts.macAppIdentity?.accountsBrokerRoot, defaultTweakersAccountsBrokerRoot(root));
        const candidate = String(opts.app);
        const paths = opts.candidateContext!.paths;
        mkdirSync(paths.runtime, { recursive: true });
        mkdirSync(paths.tweaks, { recursive: true });
        writePlist(join(candidate, "Contents", "Info.plist"), {
          CFBundleIdentifier: TWEAKERS_VARIANT_BUNDLE_ID,
          CFBundleName: "Tweakers",
          CFBundleDisplayName: "Tweakers",
          CFBundleExecutable: "ChatGPT",
          CrProductDirName: TWEAKERS_VARIANT_PRODUCT_NAME,
          BundleSigningBaseName: "Tweakers",
          TweakersOriginalExecutable: TWEAKERS_ORIGINAL_EXECUTABLE,
          LSEnvironment: {
            CODEX_ELECTRON_USER_DATA_PATH: opts.macAppIdentity!.appUserDataRoot,
            CODEX_HOME: opts.macAppIdentity!.codexHomeRoot,
            CODEX_SQLITE_HOME: opts.macAppIdentity!.codexHomeRoot,
            CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
            TWEAKERS_ACCOUNTS_BROKER_ROOT: opts.macAppIdentity!.accountsBrokerRoot,
            TWEAKER_ACCOUNTS_BROKER_ROOT: opts.macAppIdentity!.accountsBrokerRoot,
            TWEAKERS_DERIVED_VARIANT: "1",
          },
          CFBundleIconFile: TWEAKERS_VARIANT_ICON_FILE,
          CFBundleURLTypes: [{ CFBundleURLSchemes: ["tweakers"] }],
          SUEnableAutomaticChecks: false,
          SUAutomaticallyUpdate: false,
        });
        mkdirSync(join(candidate, "Contents", "MacOS"), { recursive: true });
        writeFileSync(join(candidate, "Contents", "MacOS", "ChatGPT"), "launcher", { mode: 0o755 });
        writeFileSync(
          join(candidate, "Contents", "MacOS", TWEAKERS_ORIGINAL_EXECUTABLE),
          "electron",
          { mode: 0o755 },
        );
        const launcherConfig = join(candidate, "Contents", "Resources", "tweakers");
        mkdirSync(launcherConfig, { recursive: true, mode: 0o700 });
        for (const [configPath, value] of [
          [TWEAKERS_VARIANT_USER_DATA_CONFIG, opts.macAppIdentity!.appUserDataRoot],
          [TWEAKERS_VARIANT_CODEX_HOME_CONFIG, opts.macAppIdentity!.codexHomeRoot],
          [TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG, opts.macAppIdentity!.accountsBrokerRoot],
        ] as const) {
          writeFileSync(join(candidate, "Contents", "Resources", configPath), `${value}\n`, { mode: 0o600 });
        }
        for (const name of TWEAKERS_VARIANT_DOCK_ICON_FILES) {
          writeFileSync(
            join(candidate, "Contents", "Resources", name),
            readFileSync(TWEAKERS_VARIANT_PNG_SOURCE),
          );
        }
        writeFileSync(paths.stateFile, JSON.stringify({
          appRoot: candidate,
          watcher: "none",
          signingMode: "local-identity",
          signingIdentity: "Tweakers Local Signing",
        }));
      },
    });
    assert.equal(observedHome, userRoot);
    assert.equal(publishedManagerRoot, managerRoot);
    assert.notEqual(process.env.TWEAKERS_HOME, userRoot);
    assert.equal(existsSync(join(userRoot, "codex-home")), true);
    assert.equal(existsSync(join(userRoot, "sqlite-home")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createTweakersVariant removes its native user-data link when installation fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-"));
  const source = join(root, "ChatGPT.app");
  const target = join(root, "Tweakers.app");
  const userRoot = join(root, "state");
  const nativeLink = join(root, "Library", "Application Support", TWEAKERS_VARIANT_PRODUCT_NAME);
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
        gatekeeper: () => ({ ok: true, output: "accepted" }),
        cloneApp: (_from, to) => mkdirSync(to, { recursive: true }),
        stageTweaks: () => {},
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

test("refreshTweakersVariant restores the prior app and state for every promotion filesystem fault", async () => {
  const faultPoints = [
    "state:prepare:state:mkdir",
    "state:prepare:state:write",
    "state:prepare:state:rename",
    "state:prepare:config:mkdir",
    "state:prepare:config:write",
    "state:prepare:config:rename",
    "promotion:prepare:archive:mkdir",
    "promotion:prepare:failed:mkdir",
    ...["app", "runtime", "tweaks", "state.json", "config.json"].flatMap((name) => [
      `promotion:${name}:archive:mkdir`,
      `promotion:${name}:archive:rename`,
      `promotion:${name}:promote:destination-mkdir`,
      `promotion:${name}:promote:failed-mkdir`,
      `promotion:${name}:promote:rename`,
    ]),
  ];

  for (const faultPoint of faultPoints) {
    await assertPromotionRollback(faultPoint);
  }
});

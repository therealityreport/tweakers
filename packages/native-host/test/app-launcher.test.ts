import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const launcherName = "Tweakers App Launcher";
const electronName = "Tweakers Electron";
const installedLauncherName = "ChatGPT";
const launcherSource = join(process.cwd(), "packages", "native-host", "dist", launcherName);
const launcherImplementation = join(process.cwd(), "packages", "native-host", "src", "tweakers_app_launcher.mm");
const buildScript = join(process.cwd(), "packages", "native-host", "scripts", "build.mjs");
const copyAssetsScript = join(process.cwd(), "packages", "installer", "scripts", "copy-assets.mjs");

interface Fixture {
  root: string;
  app: string;
  launcher: string;
  output: string;
  userData: string;
  codexHome: string;
  brokerRoot: string;
  config: string;
  doctorOutput: string;
  managerLauncher: string | null;
}

function writePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function stageFixture(options: { missingBroker?: boolean; malformedUserData?: boolean; withDoctor?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "tweakers-app-launcher-test-"));
  const app = join(root, "Tweakers.app");
  const macos = join(app, "Contents", "MacOS");
  const config = join(app, "Contents", "Resources", "tweakers");
  const userDataPath = join(root, "private-user-data");
  const codexHomePath = join(root, "private-codex-home");
  const brokerRoot = join(root, "absent-broker-root");
  const output = join(root, "observed.json");
  const doctorOutput = join(root, "doctor-observed.json");
  writePrivateDirectory(macos);
  writePrivateDirectory(config);
  writePrivateDirectory(userDataPath);
  writePrivateDirectory(codexHomePath);
  // macOS commonly reports /var while realpath resolves /private/var. The
  // signed records must contain the exact canonical strings the launcher
  // admits, not the caller's lexical alias.
  const userData = realpathSync(userDataPath);
  const codexHome = realpathSync(codexHomePath);
  if (!options.missingBroker) writePrivateDirectory(brokerRoot);
  // The generated asset keeps a descriptive name, but installation replaces
  // the bundle's original declared CFBundleExecutable path.
  const launcher = join(macos, installedLauncherName);
  // Keep the real launcher implementation, but bind its trusted OS home lookup
  // to this fixture. A copied production launcher can discover the operator's
  // installed continuity manager even when all signed app paths are temporary.
  const isolatedSource = join(root, "isolated-launcher.mm");
  writeFileSync(isolatedSource, `#include <pwd.h>
static struct passwd *fixtureGetPwuid(uid_t uid) {
  struct passwd *record = getpwuid(uid);
  if (record == nullptr) return nullptr;
  static struct passwd isolated;
  static char fixtureHome[] = ${JSON.stringify(realpathSync(root))};
  isolated = *record;
  isolated.pw_dir = fixtureHome;
  return &isolated;
}
#define getpwuid fixtureGetPwuid
#include ${JSON.stringify(launcherImplementation)}
`, { mode: 0o600 });
  const compiled = spawnSync("/usr/bin/xcrun", [
    "clang++", "-std=c++20", "-fobjc-arc", "-ObjC++",
    "-mmacosx-version-min=13.0", "-framework", "AppKit",
    isolatedSource, "-o", launcher,
  ], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  chmodSync(launcher, 0o755);
  writeFileSync(join(macos, electronName), `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(output)}, JSON.stringify({
  argv: process.argv.slice(2),
  environmentKeys: Object.keys(process.env).sort(),
  environment: {
    HOME: process.env.HOME,
    CODEX_ELECTRON_USER_DATA_PATH: process.env.CODEX_ELECTRON_USER_DATA_PATH,
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME,
    TWEAKERS_ACCOUNTS_BROKER_ROOT: process.env.TWEAKERS_ACCOUNTS_BROKER_ROOT,
    TWEAKER_ACCOUNTS_BROKER_ROOT: process.env.TWEAKER_ACCOUNTS_BROKER_ROOT,
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED,
    TWEAKERS_DERIVED_VARIANT: process.env.TWEAKERS_DERIVED_VARIANT,
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
    TWEAKERS_TEST_PARENT_SECRET: process.env.TWEAKERS_TEST_PARENT_SECRET,
  },
}));
`, { mode: 0o755 });
  chmodSync(join(macos, electronName), 0o755);
  let managerLauncher: string | null = null;
  if (options.withDoctor) {
    managerLauncher = join(
      realpathSync(root),
      "Library", "Application Support", "Tweakers", "managers", "com.thomashulihan.tweakers",
      "generations", "a".repeat(64), "Tweakers Manager Launcher",
    );
    mkdirSync(join(root, "Library", "Application Support", "Menu Bar", "manager-descriptors"), { recursive: true });
    mkdirSync(join(managerLauncher, ".."), { recursive: true });
    writeFileSync(managerLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(managerLauncher, 0o755);
    writeFileSync(
      join(root, "Library", "Application Support", "Menu Bar", "manager-descriptors", "com.thomashulihan.tweakers.json"),
      `${JSON.stringify({ executable: managerLauncher })}\n`,
      { mode: 0o600 },
    );
    const doctor = join(app, "Contents", "Resources", "tweakers", "native", "Tweakers Doctor.app", "Contents", "MacOS", "Tweakers Doctor");
    mkdirSync(join(doctor, ".."), { recursive: true });
    writeFileSync(doctor, `#!${process.execPath}\nconst { writeFileSync, renameSync } = require("node:fs");\nwriteFileSync(${JSON.stringify(doctorOutput + ".tmp")}, JSON.stringify({ argv: process.argv.slice(2), secret: process.env.TWEAKERS_TEST_PARENT_SECRET ?? null, codexHome: process.env.CODEX_HOME ?? null }));\nrenameSync(${JSON.stringify(doctorOutput + ".tmp")}, ${JSON.stringify(doctorOutput)});\n`, { mode: 0o755 });
    chmodSync(doctor, 0o755);
  }
  writeFileSync(join(config, "variant-user-data-path"), `${options.malformedUserData ? "relative-path" : userData}\n`, { mode: 0o600 });
  writeFileSync(join(config, "variant-codex-home-path"), `${codexHome}\n`, { mode: 0o600 });
  writeFileSync(join(config, "variant-accounts-broker-root"), `${brokerRoot}\n`, { mode: 0o600 });
  return { root, app, launcher, output, userData, codexHome, brokerRoot, config, doctorOutput, managerLauncher };
}

function waitForFile(path: string): boolean {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (existsSync(path)) return true;
    Atomics.wait(pause, 0, 0, 25);
  }
  return existsSync(path);
}

test("app launcher source binds all pre-singleton identity inputs and scoped asset publication", () => {
  const source = readFileSync(launcherImplementation, "utf8");
  assert.match(source, /kElectronName\[\] = "Tweakers Electron"/);
  assert.match(source, /kDoctorRelativeExecutable\[\] = "Resources\/tweakers\/native\/Tweakers Doctor\.app\/Contents\/MacOS\/Tweakers Doctor"/);
  assert.match(source, /kInstalledLauncherName\[\] = "ChatGPT"/);
  assert.match(source, /Basename\(launcher\) != kInstalledLauncherName/);
  assert.match(source, /variant-user-data-path/);
  assert.match(source, /variant-codex-home-path/);
  assert.match(source, /variant-accounts-broker-root/);
  assert.match(source, /CODEX_ELECTRON_USER_DATA_PATH/);
  assert.match(source, /CODEX_HOME/);
  assert.match(source, /CODEX_SQLITE_HOME/);
  assert.match(source, /CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED/);
  assert.match(source, /TWEAKERS_DERIVED_VARIANT/);
  assert.match(source, /TWEAKERS_ACCOUNTS_BROKER_ROOT/);
  assert.match(source, /TWEAKER_ACCOUNTS_BROKER_ROOT/);
  assert.match(source, /RemoveUntrustedUserDataSwitches/);
  assert.match(source, /--user-data-dir=/);
  assert.match(source, /execve\(electron\.c_str\(\)/);
  assert.doesNotMatch(source, /\bexecv\(electron\.c_str\(\)/);
  assert.match(source, /ReadVerifiedManagerLauncher/);
  assert.match(source, /manager-descriptors\/com\.thomashulihan\.tweakers\.json/);
  assert.match(source, /LaunchDoctorForEarlyFailure/);
  assert.match(source, /posix_spawn\(&child, doctor\.c_str\(\)/);
  assert.match(source, /return failToDoctor\(\)/);
  assert.doesNotMatch(source, /openURL|openApplication|\/Applications\/ChatGPT\.app/);
  const build = readFileSync(buildScript, "utf8");
  assert.match(build, /tweakers_app_launcher\.mm/);
  assert.match(build, /Tweakers App Launcher/);
  const copy = readFileSync(copyAssetsScript, "utf8");
  assert.match(copy, /packages\/native-host\/dist\/Tweakers App Launcher/);
  assert.match(copy, /assets\/app-launcher/);
  assert.match(copy, /only === "app-launcher"/);
});

test("app launcher starts the preserved Electron with signed pre-singleton isolation and an absent broker", { skip: process.platform !== "darwin" }, () => {
  assert.equal(existsSync(launcherSource), true, "app launcher must be built before tests");
  const fixture = stageFixture({ missingBroker: true });
  try {
    const result = spawnSync(fixture.launcher, [
      "--user-data-dir=/attacker-one",
      "--user-data-dir",
      "/attacker-two",
      "--ordinary-switch=value",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_ELECTRON_USER_DATA_PATH: "/attacker-user-data",
        CODEX_HOME: "/attacker-codex-home",
        CODEX_SQLITE_HOME: "/attacker-sqlite-home",
        TWEAKERS_ACCOUNTS_BROKER_ROOT: "/attacker-broker",
        TWEAKER_ACCOUNTS_BROKER_ROOT: "/attacker-compatibility-broker",
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "0",
        TWEAKERS_DERIVED_VARIANT: "0",
        ELECTRON_RUN_AS_NODE: "1",
        TWEAKERS_TEST_PARENT_SECRET: "must-not-cross-the-launcher",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(readFileSync(fixture.output, "utf8")) as {
      argv: string[];
      environmentKeys: string[];
      environment: Record<string, string | undefined>;
    };
    assert.deepEqual(observed.argv, [`--user-data-dir=${fixture.userData}`, "--ordinary-switch=value"]);
    assert.deepEqual(observed.environment, {
      HOME: realpathSync(fixture.root),
      CODEX_ELECTRON_USER_DATA_PATH: fixture.userData,
      CODEX_HOME: fixture.codexHome,
      CODEX_SQLITE_HOME: fixture.codexHome,
      TWEAKERS_ACCOUNTS_BROKER_ROOT: fixture.brokerRoot,
      TWEAKER_ACCOUNTS_BROKER_ROOT: fixture.brokerRoot,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
      TWEAKERS_DERIVED_VARIANT: "1",
    });
    assert.equal(observed.environment.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(observed.environment.TWEAKERS_TEST_PARENT_SECRET, undefined);
    assert.deepEqual(observed.environmentKeys, [
      "CODEX_ELECTRON_USER_DATA_PATH",
      "CODEX_HOME",
      "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED",
      "CODEX_SQLITE_HOME",
      "HOME",
      "LANG",
      "LOGNAME",
      "MallocNanoZone",
      "PATH",
      "SHELL",
      "TMPDIR",
      "TWEAKERS_ACCOUNTS_BROKER_ROOT",
      "TWEAKERS_DERIVED_VARIANT",
      "TWEAKER_ACCOUNTS_BROKER_ROOT",
      "USER",
      // CoreFoundation derives this from the trusted user identity after
      // execve; it was not inherited from the parent process.
      "__CF_USER_TEXT_ENCODING",
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("app launcher fails closed before Electron when its signed launch configuration is malformed", { skip: process.platform !== "darwin" }, () => {
  assert.equal(existsSync(launcherSource), true, "app launcher must be built before tests");
  const fixture = stageFixture({ malformedUserData: true });
  try {
    const result = spawnSync(fixture.launcher, [], { encoding: "utf8", env: { ...process.env } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signed launch configuration is not a canonical absolute path/);
    assert.equal(existsSync(fixture.output), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("app launcher routes an early failure to Doctor with only the verified manager launcher", { skip: process.platform !== "darwin" }, () => {
  const fixture = stageFixture({ malformedUserData: true, withDoctor: true });
  try {
    const result = spawnSync(fixture.launcher, [], {
      encoding: "utf8",
      env: { ...process.env, TWEAKERS_TEST_PARENT_SECRET: "must-not-cross-doctor" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signed launch configuration is not a canonical absolute path/);
    assert.equal(existsSync(fixture.output), false, "failed Tweakers launch must not reach Electron");
    assert.equal(waitForFile(fixture.doctorOutput), true, "Doctor helper should be launched");
    assert.deepEqual(JSON.parse(readFileSync(fixture.doctorOutput, "utf8")), {
      argv: [fixture.managerLauncher],
      secret: null,
      codexHome: null,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The root test script builds this package first (mirroring native-host), so a
// missing bundle is a build failure, never a skip.
const appRoot = join(process.cwd(), "packages/switcher/dist/Tweakers Switcher.app");
const binaryPath = join(appRoot, "Contents", "MacOS", "Tweakers Switcher");
const infoPlistPath = join(appRoot, "Contents", "Info.plist");

const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcffaedfe, 0xcefaedfe]);

test("switcher app bundle has the expected structure", { skip: process.platform !== "darwin" }, () => {
  assert.equal(existsSync(appRoot), true, "switcher app must be built before tests");
  assert.equal(existsSync(binaryPath), true, "bundle must contain Contents/MacOS/Tweakers Switcher");

  const magic = readFileSync(binaryPath).subarray(0, 4).readUInt32BE(0);
  assert.equal(MACHO_MAGICS.has(magic), true, "switcher binary must be a Mach-O executable");

  const info = readFileSync(infoPlistPath, "utf8");
  assert.match(info, /<key>CFBundleIdentifier<\/key>\s*<string>com\.therealityreport\.tweakers\.switcher<\/string>/);
  assert.match(info, /<key>CFBundleExecutable<\/key>\s*<string>Tweakers Switcher<\/string>/);
  // LSUIElement keeps the switcher out of the Dock — menu bar only.
  assert.match(info, /<key>LSUIElement<\/key>\s*<true\/>/);
});

test("switcher delegate is owned by a static strong reference", () => {
  const source = readFileSync(join(process.cwd(), "packages/switcher/src/tweakers_switcher.m"), "utf8");
  // NSApplication.delegate is weak: without a static strong owner, an ARC
  // optimized build (-O2) may dealloc the delegate before
  // applicationDidFinishLaunching fires — a permanently headless switcher.
  assert.match(source, /static TWSAppDelegate \*sDelegate;/);
  assert.match(source, /app\.delegate = sDelegate;/);
});

test("switcher offers a coordinated development reload only in Tweakers mode", () => {
  const source = readFileSync(join(process.cwd(), "packages/switcher/src/tweakers_switcher.m"), "utf8");
  assert.match(
    source,
    /if \(\[_mode isEqualToString:TWSModeTweakers\]\) \{[\s\S]*Reload Tweakers with Latest Changes…[\s\S]*refreshAvailable \? @selector\(reloadTweakers:\) : NULL/,
  );
  assert.match(
    source,
    /arrayByAddingObjectsFromArray:@\[[\s\S]*@"refresh-local", @"--source", @"development", @"--app", TWSAppRoot\(\)/,
  );
  assert.match(source, /NSArray<NSString \*> \*cli = TWSRefreshCliInvocation\(\)/);
  assert.match(source, /\[@"developmentSourceRoot"\]/);
  assert.match(source, /stringByAppendingPathComponent:@"packages\/installer\/dist\/cli\.js"/);
  assert.match(source, /isExecutableFileAtPath:cli\[0\]/);
  assert.match(source, /refreshCli\[refreshCli\.count - 1\] = developmentCli/);
  assert.match(source, /build the registered development checkout and validate a disposable candidate while ChatGPT remains open/);
  assert.match(source, /If validation or promotion fails, the current app is kept or restored/);
  assert.match(source, /tweaker dev-sync/);
  assert.match(source, /if \(!TWSSpawnDetached\(argv\)\)/);
});

test("switcher gives development refreshes the configured Node toolchain PATH", () => {
  const source = readFileSync(join(process.cwd(), "packages/switcher/src/tweakers_switcher.m"), "utf8");
  assert.match(source, /NSString \*runtimeBin = \[argv\[0\] stringByDeletingLastPathComponent\]/);
  assert.match(source, /childEnv\[@"PATH"\] = \[NSString stringWithFormat:@"%@:%@", runtimeBin, existingPath\]/);
  assert.match(source, /posix_spawn\(&pid, cargv\[0\], &actions, &attr, cargv, cenv\)/);
  assert.doesNotMatch(source, /posix_spawn\([^;]*cargv, environ\)/);
});

test("switcher delegates preparation, confirmation, and verified restart to the mode coordinator", () => {
  const source = readFileSync(join(process.cwd(), "packages/switcher/src/tweakers_switcher.m"), "utf8");
  assert.match(source, /arrayByAddingObjectsFromArray:@\[ @"mode", target \]/);
  assert.doesNotMatch(source, /@"mode", target, @"--yes"/);
  assert.doesNotMatch(source, /confirm\.messageText[\s\S]*Switch to Tweakers mode/);
});

test("switcher reports cached desktop update truth independently of app mode", () => {
  const source = readFileSync(join(process.cwd(), "packages/switcher/src/tweakers_switcher.m"), "utf8");
  assert.match(source, /TWSDesktopUpdateStatusFromMetadata/);
  assert.match(source, /@"codexAppcastCache"/);
  assert.match(source, /@"Contents\/Info\.plist"/);
  assert.match(source, /TWSAppcastFreshnessSeconds = 24 \* 60 \* 60/);
  assert.match(
    source,
    /TWSDesktopUpdateStatus \*desktopUpdate = TWSCurrentDesktopUpdateStatus\(\);[\s\S]*addItemWithTitle:TWSDesktopUpdateMenuTitle\(desktopUpdate\)[\s\S]*if \(\[_mode isEqualToString:TWSModeTweakers\]\)/,
  );
  assert.doesNotMatch(source, /NSURLSession|dataTaskWithRequest|dataTaskWithURL/);
});

test("switcher desktop update comparison handles current, available, missing, and stale data", {
  skip: process.platform !== "darwin",
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tweakers-switcher-update-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = join(directory, "desktop-update-regression");
  const sdk = spawnSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" });
  assert.equal(sdk.status, 0, `xcrun --show-sdk-path failed: ${sdk.stderr}`);
  const compile = spawnSync("xcrun", [
    "clang",
    "-fobjc-arc",
    "-mmacosx-version-min=13.0",
    "-isysroot",
    sdk.stdout.trim(),
    "-framework",
    "AppKit",
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    join(process.cwd(), "packages/switcher/test/desktop_update_harness.m"),
    "-o",
    binary,
  ], { encoding: "utf8" });
  assert.equal(compile.status, 0, `desktop update harness compile failed: ${compile.stderr}`);

  const run = spawnSync(binary, [], { encoding: "utf8" });
  assert.equal(run.status, 0, `desktop update harness failed: ${run.stderr}`);
  assert.match(run.stdout, /desktop update regression checks passed/);
});

test("switcher mode indicator uses live bundle evidence instead of state.mode", () => {
  const source = readFileSync(join(process.cwd(), "packages/switcher/src/tweakers_switcher.m"), "utf8");
  assert.match(source, /TWSLiveAsarIntegrityHash/);
  assert.match(source, /TWSHasValidOpenAISignature/);
  assert.match(source, /TWSModeFromEvidence/);
  assert.doesNotMatch(source, /return mode;/);
});

test("switcher app passes ad-hoc codesign verification", { skip: process.platform !== "darwin" }, () => {
  const result = spawnSync("codesign", ["--verify", "--strict", appRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, `codesign --verify failed: ${result.stderr}`);
});

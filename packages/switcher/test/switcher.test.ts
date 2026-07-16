import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  assert.match(source, /tweakers dev-sync/);
  assert.match(source, /if \(!TWSSpawnDetached\(argv\)\)/);
});

test("switcher gives development refreshes the configured Node toolchain PATH", () => {
  const source = readFileSync(join(process.cwd(), "packages/switcher/src/tweakers_switcher.m"), "utf8");
  assert.match(source, /NSString \*runtimeBin = \[argv\[0\] stringByDeletingLastPathComponent\]/);
  assert.match(source, /childEnv\[@"PATH"\] = \[NSString stringWithFormat:@"%@:%@", runtimeBin, existingPath\]/);
  assert.match(source, /posix_spawn\(&pid, cargv\[0\], &actions, &attr, cargv, cenv\)/);
  assert.doesNotMatch(source, /posix_spawn\([^;]*cargv, environ\)/);
});

test("switcher app passes ad-hoc codesign verification", { skip: process.platform !== "darwin" }, () => {
  const result = spawnSync("codesign", ["--verify", "--strict", appRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, `codesign --verify failed: ${result.stderr}`);
});

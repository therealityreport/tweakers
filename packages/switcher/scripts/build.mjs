// Builds the Tweakers menu-bar switcher: clang-compiles the single ObjC file,
// assembles a minimal `Tweakers Switcher.app` bundle (LSUIElement, no Dock
// icon), and ad-hoc signs it. The per-machine local-identity signature is
// applied later, at `tweaker mode setup` time, because that identity only
// exists on the end user's machine.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = resolve(root, "src", "tweakers_switcher.m");
const distRoot = resolve(root, "dist");
const outputAppRoot = resolve(distRoot, "Tweakers Switcher.app");

if (process.platform !== "darwin") {
  console.log("[switcher] skipping macOS menu-bar switcher build on non-darwin platform");
  process.exit(0);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "tweakers-switcher-build-"));
const appRoot = resolve(temporaryRoot, "Tweakers Switcher.app");
const contents = resolve(appRoot, "Contents");
const binary = resolve(contents, "MacOS", "Tweakers Switcher");

try {
  mkdirSync(resolve(contents, "MacOS"), { recursive: true });

  const sdkPath = run("xcrun", ["--show-sdk-path"]).trim();

  run("xcrun", [
    "clang",
    "-fobjc-arc",
    "-mmacosx-version-min=13.0",
    "-isysroot",
    sdkPath,
    "-framework",
    "AppKit",
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    src,
    "-o",
    binary,
  ], { stdio: "inherit" });

  writeFileSync(resolve(contents, "Info.plist"), infoPlist());
  writeFileSync(resolve(contents, "PkgInfo"), "APPL????");

  // File Provider-managed worktrees can reattach Finder metadata between an
  // xattr cleanup and codesign. Assemble/sign in a local temporary directory,
  // then publish the already sealed bundle into dist.
  run("xattr", ["-cr", appRoot], { stdio: "inherit" });
  run("codesign", ["--force", "--sign", "-", appRoot], { stdio: "inherit" });
  run("codesign", ["--verify", "--strict", appRoot], { stdio: "inherit" });

  mkdirSync(distRoot, { recursive: true });
  rmSync(outputAppRoot, { recursive: true, force: true });
  cpSync(appRoot, outputAppRoot, { recursive: true });
  run("xattr", ["-cr", outputAppRoot], { stdio: "inherit" });
  console.log(`[switcher] built ${outputAppRoot}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Tweakers Switcher</string>
  <key>CFBundleExecutable</key>
  <string>Tweakers Switcher</string>
  <key>CFBundleIdentifier</key>
  <string>com.therealityreport.tweakers.switcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Tweakers Switcher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
`;
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : "";
    const stdout = result.stdout ? `\n${result.stdout}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${stdout}${stderr}`);
  }
  return result.stdout ?? "";
}

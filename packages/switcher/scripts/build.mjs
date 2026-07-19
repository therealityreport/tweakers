// Builds the Tweakers menu-bar switcher: clang-compiles the single ObjC file,
// assembles a minimal `Tweakers Switcher.app` bundle (LSUIElement, no Dock
// icon), and ad-hoc signs it. The per-machine local-identity signature is
// applied later, at `tweaker mode setup` time, because that identity only
// exists on the end user's machine.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = resolve(root, "src", "tweakers_switcher.m");
const appRoot = resolve(root, "dist", "Tweakers Switcher.app");
const contents = resolve(appRoot, "Contents");
const binary = resolve(contents, "MacOS", "Tweakers Switcher");

if (process.platform !== "darwin") {
  console.log("[switcher] skipping macOS menu-bar switcher build on non-darwin platform");
  process.exit(0);
}

rmSync(appRoot, { recursive: true, force: true });
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

// Info.plist must exist before signing: the bundle seal covers it.
run("codesign", ["--force", "--sign", "-", appRoot], { stdio: "inherit" });
console.log(`[switcher] built ${appRoot}`);

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

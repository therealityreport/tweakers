import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = resolve(root, "src", "tweaker_native_host.mm");
const outDir = resolve(root, "dist");
const out = resolve(outDir, "tweaker_native_host.node");
const helperSource = resolve(root, "src", "tweaker_swap_helper.mm");
const helperOutput = resolve(outDir, "Tweakers Swap Helper.app");

mkdirSync(outDir, { recursive: true });

if (process.platform !== "darwin") {
  console.log("[native-host] skipping macOS native host build on non-darwin platform");
  process.exit(0);
}

const includeDir = findNodeIncludeDir();
const sdkPath = run("xcrun", ["--show-sdk-path"]).trim();

run("xcrun", [
  "clang++",
  "-std=c++20",
  "-fobjc-arc",
  "-ObjC++",
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  // Node 20 exposes Node-API 9. The host uses only older stable APIs, so
  // targeting 9 keeps one ABI-compatible binary loadable on Node 20+.
  "-DNAPI_VERSION=9",
  "-mmacosx-version-min=13.0",
  "-isysroot",
  sdkPath,
  `-I${includeDir}`,
  "-framework",
  "AppKit",
  "-framework",
  "Foundation",
  "-framework",
  "Metal",
  "-framework",
  "MetalKit",
  "-framework",
  "QuartzCore",
  src,
  "-o",
  out,
], { stdio: "inherit" });

run("codesign", ["--force", "--sign", "-", out], { stdio: "inherit" });
console.log(`[native-host] built ${out}`);

const temporaryRoot = mkdtempSync(join(tmpdir(), "tweakers-swap-helper-build-"));
try {
  const appRoot = resolve(temporaryRoot, "Tweakers Swap Helper.app");
  const contents = resolve(appRoot, "Contents");
  const binary = resolve(contents, "MacOS", "Tweakers Swap Helper");
  mkdirSync(dirname(binary), { recursive: true });
  run("xcrun", [
    "clang++",
    "-std=c++20",
    "-fobjc-arc",
    "-ObjC++",
    "-mmacosx-version-min=13.0",
    "-isysroot",
    sdkPath,
    "-framework",
    "Foundation",
    helperSource,
    "-o",
    binary,
  ], { stdio: "inherit" });
  writeFileSync(resolve(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Tweakers Swap Helper</string>
<key>CFBundleIdentifier</key><string>com.therealityreport.tweakers.swap-helper</string>
<key>CFBundleName</key><string>Tweakers Swap Helper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
`);
  run("xattr", ["-cr", appRoot], { stdio: "inherit" });
  run("codesign", ["--force", "--sign", "-", appRoot], { stdio: "inherit" });
  run("codesign", ["--verify", "--strict", appRoot], { stdio: "inherit" });
  rmSync(helperOutput, { recursive: true, force: true });
  cpSync(appRoot, helperOutput, { recursive: true });
  run("xattr", ["-cr", helperOutput], { stdio: "inherit" });
  console.log(`[native-host] built ${helperOutput}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function findNodeIncludeDir() {
  const candidates = [
    process.env.npm_config_nodedir ? join(process.env.npm_config_nodedir, "include", "node") : null,
    join(dirname(process.execPath), "..", "include", "node"),
    "/opt/homebrew/include/node",
    "/usr/local/include/node",
    "/usr/include/node",
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, "node_api.h"))) return dir;
  }
  throw new Error(`Could not find node_api.h. Tried: ${candidates.join(", ")}`);
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

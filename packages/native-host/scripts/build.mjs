import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = resolve(root, "src", "tweaker_native_host.mm");
const managerLauncherSource = resolve(root, "src", "tweakers_manager_launcher.mm");
const outDir = resolve(root, "dist");
const out = resolve(outDir, "tweaker_native_host.node");
const managerLauncherOutput = resolve(outDir, "Tweakers Manager Launcher");
const managerLauncherAsset = resolve(root, "assets", "Tweakers Manager Launcher");
const managerSigningPolicy = readManagerSigningPolicy(resolve(root, "manager-signing-policy.json"));
const releaseManagerLauncher = process.argv.includes("--release-manager-launcher");
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
  "-framework",
  "Security",
  `-DTWEAKERS_MANAGER_CERTIFICATE_LEAF_SHA1=\"${managerSigningPolicy.certificateLeafSha1}\"`,
  managerLauncherSource,
  "-o",
  managerLauncherOutput,
], { stdio: "inherit" });
const managerLauncherIdentity = releaseManagerLauncher ? findExactManagerLauncherIdentity() : "-";
run("codesign", [
  "--force",
  "--sign",
  managerLauncherIdentity,
  "--identifier",
  managerSigningPolicy.identifier,
  ...(releaseManagerLauncher ? ["--options", "runtime"] : []),
  managerLauncherOutput,
], { stdio: "inherit" });
run("codesign", ["--verify", "--strict", managerLauncherOutput], { stdio: "inherit" });
verifyManagerLauncherBinary(managerLauncherOutput, { requirePublisherSignature: releaseManagerLauncher });
console.log(`[native-host] built ${releaseManagerLauncher ? "publisher-signed" : "ad-hoc"} ${managerLauncherOutput}`);
if (releaseManagerLauncher) {
  mkdirSync(dirname(managerLauncherAsset), { recursive: true });
  const stagedAsset = `${managerLauncherAsset}.candidate-${process.pid}`;
  rmSync(stagedAsset, { force: true });
  cpSync(managerLauncherOutput, stagedAsset);
  verifyManagerLauncherBinary(stagedAsset, { requirePublisherSignature: true });
  renameSync(stagedAsset, managerLauncherAsset);
  console.log(`[native-host] promoted verified publisher launcher to ${managerLauncherAsset}`);
}

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

function findExactManagerLauncherIdentity() {
  const output = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  const matches = [...output.matchAll(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"Tweakers Local Signing"\s*$/gm)]
    .map((match) => match[1].toUpperCase());
  const unique = [...new Set(matches)];
  const expected = managerSigningPolicy.certificateLeafSha1.toUpperCase();
  if (unique.length !== 1 || unique[0] !== expected) {
    throw new Error(`Manager release signing requires exactly the pinned ${expected} identity; same-name or replacement certificates are rejected`);
  }
  return unique[0];
}

function verifyManagerLauncherBinary(path, { requirePublisherSignature }) {
  const architectures = run("lipo", ["-archs", path]).trim();
  if (architectures !== managerSigningPolicy.architecture) {
    throw new Error(`Tweakers Manager Launcher must contain only ${managerSigningPolicy.architecture}; found ${architectures}`);
  }
  const output = run("codesign", ["-d", "-r-", "--verbose=4", path], { includeStderr: true });
  if (signingOutputValue(output, "Identifier=") !== managerSigningPolicy.identifier) {
    throw new Error("Tweakers Manager Launcher identifier did not verify");
  }
  if (requirePublisherSignature
      && (signingOutputValue(output, "Authority=") !== managerSigningPolicy.certificateCommonName
        || signingOutputValue(output, "designated => ") !== managerSigningPolicy.designatedRequirement)) {
    throw new Error("Tweakers Manager Launcher exact publisher designated requirement did not verify");
  }
}

function readManagerSigningPolicy(path) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("manager-signing-policy.json is malformed or internally inconsistent");
  }
  if (!isRecord(policy)
    || policy.schemaVersion !== 1
    || policy.managerId !== "com.thomashulihan.tweakers"
    || policy.protocolVersion !== 1
    || policy.executableName !== "Tweakers Manager Launcher"
    || policy.identifier !== "com.therealityreport.tweakers.manager-launcher"
    || policy.architecture !== "arm64"
    || policy.certificateCommonName !== "Tweakers Local Signing"
    || typeof policy.certificateLeafSha1 !== "string"
    || !/^[a-f0-9]{40}$/.test(policy.certificateLeafSha1)
    || typeof policy.designatedRequirement !== "string"
    || policy.designatedRequirement !== `identifier "${policy.identifier}" and certificate leaf = H"${policy.certificateLeafSha1}"`) {
    throw new Error("manager-signing-policy.json is malformed or internally inconsistent");
  }
  return policy;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function signingOutputValue(output, prefix) {
  const line = output.split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length);
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
  return `${result.stdout ?? ""}${opts.includeStderr ? result.stderr ?? "" : ""}`;
}

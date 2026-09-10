import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inferCodexChannel,
  locateCodex,
  locateCodexAtExactPath,
  resolveMacElectronFrameworkBinary,
  resolveLinuxInstall,
} from "../src/platform";

test("inferCodexChannel detects stable and beta metadata", () => {
  assert.equal(inferCodexChannel("com.openai.codex", "Codex"), "stable");
  assert.equal(inferCodexChannel("com.openai.codex.beta", "Codex (Beta)"), "beta");
  assert.equal(inferCodexChannel(null, "Codex (Beta)"), "beta");
  assert.equal(inferCodexChannel("com.therealityreport.tweakers", "Tweakers"), "stable");
});

test("locateCodex reads beta bundle metadata from override path on macOS", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-platform-"));
  try {
    const app = join(root, "Codex (Beta).app");
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    mkdirSync(
      join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A"),
      { recursive: true },
    );
    writeFileSync(join(app, "Contents", "Resources", "app.asar"), "");
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>Codex (Beta)</string>
  <key>CFBundleExecutable</key><string>Codex (Beta)</string>
  <key>CFBundleIdentifier</key><string>com.openai.codex.beta</string>
</dict></plist>`,
    );

    const codex = locateCodex(app);
    assert.equal(codex.appName, "Codex (Beta)");
    assert.equal(codex.bundleId, "com.openai.codex.beta");
    assert.equal(codex.channel, "beta");
    assert.equal(codex.executable.endsWith("Contents/MacOS/Codex (Beta)"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact-path lookup never falls back to another installed desktop", { skip: process.platform !== "darwin" }, () => {
  assert.throws(
    () => locateCodexAtExactPath("/path/that/does/not/exist/ChatGPT.app"),
    /Exact Codex app path is not a valid com\.openai\.codex bundle/,
  );
});

test("macOS framework resolver recognizes current Codex Framework and legacy Electron layouts", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-platform-framework-"));
  try {
    const modern = join(root, "Modern.app");
    const modernBinary = join(
      modern,
      "Contents",
      "Frameworks",
      "Codex Framework.framework",
      "Versions",
      "Current",
      "Codex Framework",
    );
    mkdirSync(join(modernBinary, ".."), { recursive: true });
    writeFileSync(modernBinary, "modern", { mode: 0o755 });
    assert.equal(resolveMacElectronFrameworkBinary(modern), modernBinary);

    const legacy = join(root, "Legacy.app");
    const legacyBinary = join(
      legacy,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Electron Framework",
    );
    mkdirSync(join(legacyBinary, ".."), { recursive: true });
    writeFileSync(legacyBinary, "legacy", { mode: 0o755 });
    assert.equal(resolveMacElectronFrameworkBinary(legacy), legacyBinary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveLinuxInstall supports am-will codex-app install directory", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-platform-"));
  try {
    const app = join(root, "codex-desktop");
    mkdirSync(join(app, "resources"), { recursive: true });
    writeFileSync(join(app, "resources", "app.asar"), "");
    writeFileSync(join(app, "Codex"), "", { mode: 0o755 });

    const codex = resolveLinuxInstall(app);
    const resolvedApp = realpathSync(app);
    assert.ok(codex);
    assert.equal(codex.appRoot, resolvedApp);
    assert.equal(codex.resourcesDir, join(resolvedApp, "resources"));
    assert.equal(codex.executable, join(resolvedApp, "Codex"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveLinuxInstall accepts a launcher symlink override", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-platform-"));
  try {
    const app = join(root, "codex-desktop");
    const bin = join(root, "bin");
    mkdirSync(join(app, "resources"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(app, "resources", "app.asar"), "");
    writeFileSync(join(app, "codex-desktop"), "", { mode: 0o755 });
    symlinkSync(join(app, "codex-desktop"), join(bin, "codex-desktop"));

    const codex = resolveLinuxInstall(join(bin, "codex-desktop"));
    const resolvedApp = realpathSync(app);
    assert.ok(codex);
    assert.equal(codex.appRoot, resolvedApp);
    assert.equal(codex.resourcesDir, join(resolvedApp, "resources"));
    assert.equal(codex.executable, join(resolvedApp, "codex-desktop"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

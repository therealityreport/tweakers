import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyInstallerAssets } from "../scripts/copy-assets.mjs";

test("copy-assets publishes the signed launcher and standalone manager bundle as one manager asset pair", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-assets-"));
  try {
    const launcherSource = join(root, "packages", "native-host", "assets", "Tweakers Manager Launcher");
    const policySource = join(root, "packages", "native-host", "manager-signing-policy.json");
    const bundleSource = join(root, "packages", "installer", "dist", "manager.mjs");
    const assetRoot = join(root, "packages", "installer", "assets", "manager-launcher");
    mkdirSync(join(root, "packages", "loader"), { recursive: true });
    mkdirSync(join(root, "packages", "runtime", "dist"), { recursive: true });
    mkdirSync(join(root, "packages", "native-host", "assets"), { recursive: true });
    mkdirSync(join(root, "packages", "installer", "dist"), { recursive: true });
    mkdirSync(join(root, "packages", "installer", "assets"), { recursive: true });
    mkdirSync(join(root, "tweaks", "alpha"), { recursive: true });
    mkdirSync(join(root, "store"), { recursive: true });
    writeFileSync(join(root, "packages", "loader", "loader.cjs"), "loader\n");
    writeFileSync(join(root, "packages", "runtime", "dist", "main.js"), "runtime\n");
    writeFileSync(launcherSource, "signed launcher bytes\n");
    writeFileSync(policySource, "{\"schemaVersion\":1}\n");
    writeFileSync(bundleSource, "export const standalone = true;\n");
    chmodSync(launcherSource, 0o755);
    chmodSync(bundleSource, 0o644);
    writeFileSync(join(root, "tweaks", "alpha", "manifest.json"), JSON.stringify({
      id: "com.example.alpha",
      name: "alpha",
      version: "0.1.0",
      githubRepo: "example/alpha",
      scope: "renderer",
    }));
    writeFileSync(join(root, "tweaks", "alpha", "index.js"), "module.exports = {};\n");
    writeFileSync(join(root, "store", "index.json"), `${JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2)}\n`);
    mkdirSync(assetRoot, { recursive: true });
    writeFileSync(join(assetRoot, "stale-file"), "must be replaced\n");

    const result = copyInstallerAssets(root);

    assert.equal(result.runtimeCopied, true);
    const launcher = join(assetRoot, "Tweakers Manager Launcher");
    const bundle = join(assetRoot, "manager.mjs");
    assert.equal(readFileSync(launcher, "utf8"), readFileSync(launcherSource, "utf8"));
    assert.equal(readFileSync(bundle, "utf8"), readFileSync(bundleSource, "utf8"));
    assert.equal(readFileSync(join(assetRoot, "signing-policy.json"), "utf8"), readFileSync(policySource, "utf8"));
    assert.equal(lstatSync(launcher).mode & 0o777, 0o755);
    assert.equal(lstatSync(bundle).mode & 0o777, 0o644);
    assert.equal(existsSync(join(assetRoot, "stale-file")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy-assets rejects a partial manager pair before changing committed assets", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-assets-partial-"));
  try {
    const assetRoot = join(root, "packages", "installer", "assets", "manager-launcher");
    const launcherSource = join(root, "packages", "native-host", "assets", "Tweakers Manager Launcher");
    mkdirSync(join(root, "packages", "native-host", "assets"), { recursive: true });
    mkdirSync(assetRoot, { recursive: true });
    writeFileSync(launcherSource, "new launcher only\n");
    writeFileSync(join(assetRoot, "Tweakers Manager Launcher"), "preserved launcher\n");
    writeFileSync(join(assetRoot, "manager.mjs"), "preserved bundle\n");

    assert.throws(() => copyInstallerAssets(root), /requires the canonical signed launcher and freshly built status bundle/);
    assert.equal(readFileSync(join(assetRoot, "Tweakers Manager Launcher"), "utf8"), "preserved launcher\n");
    assert.equal(readFileSync(join(assetRoot, "manager.mjs"), "utf8"), "preserved bundle\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

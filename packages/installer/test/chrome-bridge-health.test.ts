import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectChromeBridge } from "../src/chrome-bridge-health";

const VERSION = "26.707.62119";
const EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg";
const HOST_NAME = "com.openai.codexextension";

interface Fixture {
  root: string;
  home: string;
  appRoot: string;
  cacheRoot: string;
  versionRoot: string;
  hostExecutable: string;
  nativeManifest: string;
  cleanup(): void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "tweakers-chrome-bridge-"));
  const home = join(root, "home");
  const appRoot = join(root, "ChatGPT.app");
  const bundledRoot = join(
    appRoot,
    "Contents/Resources/plugins/openai-bundled/plugins/chrome",
  );
  writeJson(join(bundledRoot, ".codex-plugin/plugin.json"), {
    name: "chrome",
    version: VERSION,
  });
  writeJson(join(bundledRoot, "scripts/extension-id.json"), {
    extensionId: EXTENSION_ID,
    extensionHostName: HOST_NAME,
  });

  const cacheRoot = join(home, ".codex/plugins/cache/openai-bundled/chrome");
  const versionRoot = join(cacheRoot, VERSION);
  const hostExecutable = join(
    versionRoot,
    `extension-host/macos/${process.arch === "x64" ? "x64" : "arm64"}/ChatGPT for Chrome`,
  );
  writeFile(hostExecutable, "#!/bin/sh\n", 0o755);
  chmodSync(hostExecutable, 0o755);
  symlinkSync(versionRoot, join(cacheRoot, "latest"));

  const nativeManifest = join(
    home,
    `Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json`,
  );
  writeJson(nativeManifest, {
    name: HOST_NAME,
    path: join(cacheRoot, "latest", `extension-host/macos/${process.arch === "x64" ? "x64" : "arm64"}/ChatGPT for Chrome`),
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  });
  writeJson(join(home, ".codex/chrome-native-hosts-v2.json"), {
    schemaVersion: 2,
    entries: [{
      nativeHostVersion: VERSION,
      extensionIds: [EXTENSION_ID],
      nativeHostNames: [HOST_NAME],
      paths: { extensionHostPath: hostExecutable },
    }],
  });

  return {
    root,
    home,
    appRoot,
    cacheRoot,
    versionRoot,
    hostExecutable,
    nativeManifest,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("healthy current cache and native host pass", (t) => {
  const f = fixture();
  t.after(f.cleanup);

  const health = inspectChromeBridge({ appRoot: f.appRoot, homeDir: f.home, platform: "darwin" });
  assert.equal(health?.cache.ok, true);
  assert.equal(health?.nativeHost.ok, true);
});

test("dangling latest cache projection fails", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  rmSync(f.versionRoot, { recursive: true, force: true });

  const health = inspectChromeBridge({ appRoot: f.appRoot, homeDir: f.home, platform: "darwin" });
  assert.equal(health?.cache.ok, false);
  assert.match(health?.cache.detail ?? "", /dangling cache projection/);
  assert.equal(health?.nativeHost.ok, false);
});

test("older existing cache target warns without failing", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const olderRoot = join(f.cacheRoot, "26.707.51957");
  const olderHost = join(
    olderRoot,
    `extension-host/macos/${process.arch === "x64" ? "x64" : "arm64"}/ChatGPT for Chrome`,
  );
  writeFile(olderHost, "#!/bin/sh\n", 0o755);
  chmodSync(olderHost, 0o755);
  rmSync(join(f.cacheRoot, "latest"));
  symlinkSync(olderRoot, join(f.cacheRoot, "latest"));

  const health = inspectChromeBridge({ appRoot: f.appRoot, homeDir: f.home, platform: "darwin" });
  assert.equal(health?.cache.ok, "warn");
  assert.match(health?.cache.detail ?? "", /active app bundles/);
});

test("missing cached native host executable fails", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  rmSync(f.hostExecutable);

  const health = inspectChromeBridge({ appRoot: f.appRoot, homeDir: f.home, platform: "darwin" });
  assert.equal(health?.cache.ok, false);
  assert.match(health?.cache.detail ?? "", /native host executable is missing/);
});

test("missing native manifest fails", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  rmSync(f.nativeManifest);

  const health = inspectChromeBridge({ appRoot: f.appRoot, homeDir: f.home, platform: "darwin" });
  assert.equal(health?.nativeHost.ok, false);
  assert.match(health?.nativeHost.detail ?? "", /manifest is missing/);
});

test("wrong native host origin fails", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeJson(f.nativeManifest, {
    name: HOST_NAME,
    path: f.hostExecutable,
    allowed_origins: ["chrome-extension://wrong/"],
  });

  const health = inspectChromeBridge({ appRoot: f.appRoot, homeDir: f.home, platform: "darwin" });
  assert.equal(health?.nativeHost.ok, false);
  assert.match(health?.nativeHost.detail ?? "", /does not allow/);
});

test("stale v2 registration warns while manifest remains healthy", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeJson(join(f.home, ".codex/chrome-native-hosts-v2.json"), {
    schemaVersion: 2,
    entries: [{
      nativeHostVersion: "26.707.51957",
      extensionIds: [EXTENSION_ID],
      nativeHostNames: [HOST_NAME],
    }],
  });

  const health = inspectChromeBridge({ appRoot: f.appRoot, homeDir: f.home, platform: "darwin" });
  assert.equal(health?.nativeHost.ok, "warn");
  assert.match(health?.nativeHost.detail ?? "", /v2 registration is stale/);
});

test("current v2 metadata with a missing executable path warns", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeJson(join(f.home, ".codex/chrome-native-hosts-v2.json"), {
    schemaVersion: 2,
    entries: [{
      nativeHostVersion: VERSION,
      extensionIds: [EXTENSION_ID],
      nativeHostNames: [HOST_NAME],
      paths: { extensionHostPath: join(f.root, "missing-host") },
    }],
  });

  const health = inspectChromeBridge({ appRoot: f.appRoot, homeDir: f.home, platform: "darwin" });
  assert.equal(health?.nativeHost.ok, "warn");
  assert.match(health?.nativeHost.detail ?? "", /v2 registration is stale/);
});

test("non-macOS platforms skip Chrome bridge inspection", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.equal(
    inspectChromeBridge({ appRoot: f.appRoot, homeDir: f.home, platform: "linux" }),
    null,
  );
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(path: string, contents: string, mode: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, { mode });
}

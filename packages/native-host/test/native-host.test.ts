import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const hostPath = join(process.cwd(), "packages/native-host/dist/tweaker_native_host.node");

test("native host reports AppKit and Metal capabilities", { skip: process.platform !== "darwin" }, () => {
  assert.equal(existsSync(hostPath), true, "native host must be built before tests");
  const host = require(hostPath) as {
    getCapabilities(): Record<string, unknown>;
  };
  const capabilities = host.getCapabilities();
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.appKitEmbedding, true);
  assert.equal(capabilities.childWindowOverlay, true);
  assert.equal(capabilities.directViewAttach, false);
  assert.equal(typeof capabilities.metalViews, "boolean");
});

test("native host atomically exchanges two directory entries", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-native-swap-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, "value"), "first");
    writeFileSync(join(second, "value"), "second");
    const host = require(hostPath) as { swapDirectories(first: string, second: string): void };

    host.swapDirectories(first, second);

    assert.equal(readFileSync(join(first, "value"), "utf8"), "second");
    assert.equal(readFileSync(join(second, "value"), "utf8"), "first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

test("native thread lease excludes writers, preserves its inode, and releases idempotently", { skip: process.platform !== "darwin" }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-native-lease-")));
  const name = "00000000-0000-4000-8000-000000000001.lock";
  const host = require(hostPath);
  const stat = lstatSync(root, { bigint: true });
  const lease = host.acquireNativeThreadWriterLease(root, name, String(stat.dev), String(stat.ino));
  try {
    assert.equal(lease.isHeld(), true);
    assert.equal(host.acquireNativeThreadWriterLease(root, name, String(stat.dev), String(stat.ino)), null);
    const blocked = spawnSync("python3", ["-c", "import sys,fcntl; f=open(sys.argv[1],'r+');\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(23)", join(root, name)]);
    assert.equal(blocked.status, 23, blocked.stderr.toString());
    assert.equal(String(lstatSync(join(root, name), { bigint: true }).ino), lease.ino);
    lease.release();
    lease.release();
    assert.equal(lease.isHeld(), false);
    assert.equal(existsSync(join(root, name)), true);
    const next = host.acquireNativeThreadWriterLease(root, name, String(stat.dev), String(stat.ino));
    assert.equal(next.ino, lease.ino);
    next.release();
  } finally { lease.release(); rmSync(root, { recursive: true, force: true }); }
});

test("native thread lease rejects unsafe bindings and detects replacement", { skip: process.platform !== "darwin" }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-native-lease-safety-")));
  const directory = join(root, "locks");
  mkdirSync(directory, { mode: 0o700 });
  const name = "00000000-0000-4000-8000-000000000001.lock";
  const host = require(hostPath);
  const stat = lstatSync(directory, { bigint: true });
  let lease: { release(): void; isHeld(): boolean } | null = null;
  try {
    assert.throws(() => host.acquireNativeThreadWriterLease(directory, name, String(stat.dev), "0"));
    assert.throws(() => host.acquireNativeThreadWriterLease(directory, "l".repeat(36) + ".lock", String(stat.dev), String(stat.ino)));
    writeFileSync(join(root, "target"), "");
    symlinkSync(join(root, "target"), join(directory, name));
    assert.throws(() => host.acquireNativeThreadWriterLease(directory, name, String(stat.dev), String(stat.ino)));
    rmSync(join(directory, name));
    lease = host.acquireNativeThreadWriterLease(directory, name, String(stat.dev), String(stat.ino));
    assert.equal(lease!.isHeld(), true);
    chmodSync(directory, 0o777);
    assert.equal(lease!.isHeld(), false);
    chmodSync(directory, 0o700);
    assert.equal(lease!.isHeld(), true);
    renameSync(join(directory, name), join(directory, "old.lock"));
    writeFileSync(join(directory, name), "", { mode: 0o600 });
    assert.equal(lease!.isHeld(), false);
    lease!.release();
    lease = host.acquireNativeThreadWriterLease(directory, name, String(stat.dev), String(stat.ino));
    renameSync(directory, join(root, "old-directory"));
    mkdirSync(directory, { mode: 0o700 });
    assert.equal(lease!.isHeld(), false);
  } finally { lease?.release(); rmSync(root, { recursive: true, force: true }); }
});

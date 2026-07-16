import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireRefreshLock } from "../src/commands/refresh-local";
import { acquireProcessLock, processAlive } from "../src/process-lock";

function fixture(): { root: string; lockFile: string } {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-lock-"));
  return { root, lockFile: join(root, "refresh-local.lock") };
}

test("processAlive treats PID 1 as alive", () => {
  assert.equal(processAlive(1), true);
});

test("the shared process lock reclaims a stale owner", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "999999\n");
    const lock = acquireProcessLock(lockFile);
    assert.equal(readFileSync(lockFile, "utf8"), `${process.pid}\n`);
    lock.release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shared process lock preserves a live owner's lock", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "1\n");
    const contended = new Error("contended");
    assert.throws(
      () => acquireProcessLock(lockFile, {
        onContended: (owner) => {
          assert.equal(owner, 1);
          return contended;
        },
      }),
      (error) => error === contended,
    );
    assert.equal(readFileSync(lockFile, "utf8"), "1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the refresh lock cannot be stolen from a live foreign owner", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "1\n");
    assert.throws(
      () => acquireRefreshLock(lockFile),
      /A Tweakers local refresh is already running \(PID 1\)/,
    );
    assert.equal(readFileSync(lockFile, "utf8"), "1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the refresh lock reclaims a dead owner's lock and releases it", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "999999\n");
    const lock = acquireRefreshLock(lockFile);
    assert.equal(readFileSync(lockFile, "utf8"), `${process.pid}\n`);
    lock.release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

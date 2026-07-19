import assert from "node:assert/strict";
import { closeSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("stale reclamation elects one claimant before any contender can replace its live lock", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "999999\n");
    let nestedAttempted = false;
    const lock = acquireProcessLock(lockFile, {
      afterClaimed: () => {
        nestedAttempted = true;
        assert.throws(
          () => acquireProcessLock(lockFile),
          new RegExp(`PID ${process.pid}`),
        );
      },
    });
    assert.equal(nestedAttempted, true);
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

test("a throwing contention callback still removes the elected ticket", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "1\n");
    assert.throws(
      () => acquireProcessLock(lockFile, {
        onContended: () => { throw new Error("contention callback failed"); },
      }),
      /contention callback failed/,
    );
    assert.equal(readFileSync(lockFile, "utf8"), "1\n");
    assert.deepEqual(readdirSync(`${lockFile}.claims`), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shared process lock also preserves a live same-process lock", () => {
  const { root, lockFile } = fixture();
  const first = acquireProcessLock(lockFile);
  try {
    assert.throws(
      () => acquireProcessLock(lockFile),
      new RegExp(`PID ${process.pid}`),
    );
    assert.equal(readFileSync(lockFile, "utf8"), `${process.pid}\n`);
  } finally {
    first.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failure during the settled claim inspection removes the live ticket", () => {
  const { root, lockFile } = fixture();
  try {
    assert.throws(
      () => acquireProcessLock(lockFile, {
        beforeSettledInspection: () => { throw new Error("second inspection failed"); },
      }),
      /second inspection failed/,
    );
    assert.equal(existsSync(lockFile), false);
    assert.deepEqual(readdirSync(`${lockFile}.claims`), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a claim close failure removes the claim instead of stranding the lock", () => {
  const { root, lockFile } = fixture();
  let closes = 0;
  try {
    assert.throws(
      () => acquireProcessLock(lockFile, {
        close: (fd) => {
          closes += 1;
          if (closes === 2) throw new Error("ticket close failed");
          closeSync(fd);
        },
      }),
      /ticket close failed/,
    );
    assert.equal(existsSync(lockFile), false);
    assert.deepEqual(readdirSync(`${lockFile}.claims`), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release removes the claim even when closing the projection descriptor fails", () => {
  const { root, lockFile } = fixture();
  let closes = 0;
  try {
    const lock = acquireProcessLock(lockFile, {
      close: (fd) => {
        closes += 1;
        if (closes === 3) throw new Error("projection close failed");
        closeSync(fd);
      },
    });
    lock.release();
    assert.equal(existsSync(lockFile), false);
    assert.deepEqual(readdirSync(`${lockFile}.claims`), []);
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

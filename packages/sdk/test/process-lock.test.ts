import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireProcessLock, processIdentityAlive } from "../src/process-lock";

test("reclaims a recycled PID projection and ignores incidental dotfiles", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-lock-identity-"));
  const file = join(root, "owner.lock");
  try {
    mkdirSync(`${file}.claims`);
    writeFileSync(join(`${file}.claims`, ".DS_Store"), "metadata");
    writeFileSync(file, `${process.pid}\n${JSON.stringify({ startedAt: "previous process" })}\n`);
    const lease = acquireProcessLock(file);
    try {
      assert.equal(Number.parseInt(readFileSync(file, "utf8"), 10), process.pid);
      assert.throws(() => acquireProcessLock(file), /holds this lock/);
    } finally { lease.release(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy and unidentifiable live owners remain protected", () => {
  assert.equal(processIdentityAlive(process.pid), true);
  assert.equal(processIdentityAlive(process.pid, "previous process"), false);
  const root = mkdtempSync(join(tmpdir(), "tweakers-lock-legacy-"));
  try {
    const file = join(root, "owner.lock");
    writeFileSync(file, `${process.pid}\n`);
    assert.throws(() => acquireProcessLock(file), /holds this lock/);
    assert.equal(readFileSync(file, "utf8"), `${process.pid}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

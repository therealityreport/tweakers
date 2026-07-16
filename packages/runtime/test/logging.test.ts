import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCappedLog } from "../src/logging";

test("appendCappedLog rotates at cap writing O(line) bytes, not the whole file", () => {
  const dir = mkdtempSync(join(tmpdir(), "codexpp-log-"));
  try {
    const file = join(dir, "main.log");
    const prior = "a".repeat(95);
    const line = "b".repeat(20);
    writeFileSync(file, prior);

    appendCappedLog(file, line, 100);

    const primary = readFileSync(file, "utf8");
    assert.equal(primary, line);
    assert.equal(Buffer.byteLength(primary), line.length);
    assert.ok(Buffer.byteLength(primary) <= 100);
    assert.equal(readFileSync(`${file}.1`, "utf8"), prior);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendCappedLog retains the pre-rotation content in .1", () => {
  const dir = mkdtempSync(join(tmpdir(), "codexpp-log-"));
  try {
    const file = join(dir, "retention.log");
    writeFileSync(file, "a".repeat(8));
    writeFileSync(`${file}.1`, "stale");

    appendCappedLog(file, "b".repeat(3), 10);

    assert.equal(readFileSync(file, "utf8"), "bbb");
    assert.equal(readFileSync(`${file}.1`, "utf8"), "aaaaaaaa");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendCappedLog truncates oversized entries to the byte cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "codexpp-log-"));
  try {
    const file = join(dir, "preload.log");
    appendCappedLog(file, "abcdef", 4);
    const data = readFileSync(file, "utf8");
    assert.ok(Buffer.byteLength(data) <= 4);
    assert.equal(data, "cdef");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

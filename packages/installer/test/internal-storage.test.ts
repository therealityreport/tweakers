import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertInternalStoragePath } from "../src/internal-storage.ts";

test("internal-storage proof rejects lexical and symlinked Volumes paths", {
  skip: platform() !== "darwin",
}, () => {
  assert.doesNotThrow(() => assertInternalStoragePath("/Users", "internal control"));
  assert.throws(
    () => assertInternalStoragePath("/Volumes/HardDrive/codex", "external artifact"),
    /internal storage|internal Data filesystem/,
  );

  const root = mkdtempSync(join(tmpdir(), "tweakers-volume-proof-"));
  try {
    const alias = join(root, "volume-alias");
    symlinkSync("/Volumes", alias);
    assert.throws(
      () => assertInternalStoragePath(join(alias, "HardDrive", "codex"), "symlinked artifact"),
      /internal storage|internal Data filesystem/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("internal-storage proof rejects the Data-volume alias of an external mount", {
  skip: platform() !== "darwin" || !existsSync("/System/Volumes/Data/Volumes/HardDrive"),
}, () => {
  assert.throws(
    () => assertInternalStoragePath(
      "/System/Volumes/Data/Volumes/HardDrive/codex",
      "aliased external artifact",
    ),
    /internal Data filesystem/,
  );
});

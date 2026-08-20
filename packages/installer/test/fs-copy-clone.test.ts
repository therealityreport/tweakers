import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloneOrCopyDirectoryPreservingModes } from "../src/fs-copy";

function sourceTree(root: string): string {
  const source = join(root, "source");
  mkdirSync(join(source, "private"), { recursive: true });
  writeFileSync(join(source, "artifact.txt"), "artifact", { mode: 0o644 });
  writeFileSync(join(source, "private", "secret"), "secret", { mode: 0o600 });
  writeFileSync(join(source, ".DS_Store"), "junk");
  symlinkSync("artifact.txt", join(source, "link"));
  chmodSync(join(source, "private"), 0o700);
  return source;
}

function assertPreserved(source: string, destination: string): void {
  assert.equal(readFileSync(join(destination, "artifact.txt"), "utf8"), "artifact");
  assert.equal(readFileSync(join(destination, "private", "secret"), "utf8"), "secret");
  assert.equal(lstatSync(join(destination, "private")).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(destination, "private", "secret")).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(destination, "link")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(destination, "link")), "artifact.txt");
  // Finder junk must never enter a receipt-owned artifact copy.
  assert.equal(existsSync(join(destination, ".DS_Store")), false);
  assert.equal(existsSync(join(source, ".DS_Store")), true);
}

test("clonefile path preserves modes, symlinks, and the junk sweep", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "fs-copy-clone-"));
  try {
    const source = sourceTree(root);
    const destination = join(root, "nested", "destination");
    cloneOrCopyDirectoryPreservingModes(source, destination);
    assertPreserved(source, destination);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("clone failure clears the partial copy and falls back to the preserving byte copy", () => {
  const root = mkdtempSync(join(tmpdir(), "fs-copy-clone-"));
  try {
    const source = sourceTree(root);
    const destination = join(root, "destination");
    let cloneAttempts = 0;
    cloneOrCopyDirectoryPreservingModes(source, destination, {
      execFileSync: (() => {
        cloneAttempts += 1;
        writeFileSync(destination, "partial clone debris");
        throw new Error("cross-volume");
      }) as never,
      platform: () => "darwin",
    });
    assert.equal(cloneAttempts, 1);
    assertPreserved(source, destination);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("non-darwin platforms use the preserving byte copy without invoking cp", () => {
  const root = mkdtempSync(join(tmpdir(), "fs-copy-clone-"));
  try {
    const source = sourceTree(root);
    const destination = join(root, "destination");
    cloneOrCopyDirectoryPreservingModes(source, destination, {
      execFileSync: (() => { throw new Error("cp must not run off darwin"); }) as never,
      platform: () => "linux",
    });
    assertPreserved(source, destination);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a non-directory source is rejected before any destination mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "fs-copy-clone-"));
  try {
    const file = join(root, "file.txt");
    writeFileSync(file, "not a directory");
    const destination = join(root, "existing");
    mkdirSync(destination);
    writeFileSync(join(destination, "keep.txt"), "keep");
    assert.throws(() => cloneOrCopyDirectoryPreservingModes(file, destination), /must be a real directory/);
    assert.equal(readFileSync(join(destination, "keep.txt"), "utf8"), "keep");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

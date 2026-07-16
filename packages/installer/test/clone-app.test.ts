import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloneAppTree } from "../src/transaction";

test("clonefile clone preserves symlinks, mode bits, and xattrs", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-clone-app-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    const sourceFile = join(source, "regular-file");
    mkdirSync(source, { recursive: true });
    writeFileSync(sourceFile, "clone me");
    chmodSync(sourceFile, 0o640);
    symlinkSync("regular-file", join(source, "file-link"));
    execFileSync("xattr", ["-w", "com.tweakers.test", "clone-me", sourceFile]);

    cloneAppTree(source, destination);

    const destinationFile = join(destination, "regular-file");
    assert.equal(existsSync(destinationFile), true);
    assert.equal(lstatSync(join(destination, "file-link")).isSymbolicLink(), true);
    assert.equal(lstatSync(destinationFile).mode & 0o777, 0o640);
    assert.equal(
      execFileSync("xattr", ["-p", "com.tweakers.test", destinationFile]).toString().trim(),
      "clone-me",
    );
    // Preserving bundle bytes and xattrs is also what lets the promoted clone
    // pass codesign --verify --deep --strict, guarding the biggest optimization.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to a byte copy that still preserves symlinks when clonefile fails", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-clone-app-fallback-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "regular-file"), "copy me");
    symlinkSync("regular-file", join(source, "file-link"));

    cloneAppTree(source, destination, {
      execFileSync: () => {
        throw new Error("clonefile unsupported");
      },
      platform: () => "darwin",
    });

    assert.equal(existsSync(join(destination, "regular-file")), true);
    assert.equal(lstatSync(join(destination, "file-link")).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-volume darwin clone invokes cp -Rc", () => {
  let invoked: { cmd: string; args: readonly string[] } | undefined;
  let copyDirCalled = false;

  cloneAppTree("/src", "/dst", {
    execFileSync: ((cmd: string, args: readonly string[]) => {
      invoked = { cmd, args };
      return Buffer.from("");
    }) as typeof execFileSync,
    platform: () => "darwin",
    copyDir: () => {
      copyDirCalled = true;
    },
    removeDir: () => {},
  });

  assert.equal(invoked?.cmd, "cp");
  assert.equal(invoked?.args[0], "-Rcp");
  assert.deepEqual(invoked?.args.slice(-2), ["/src", "/dst"]);
  assert.equal(copyDirCalled, false);
});

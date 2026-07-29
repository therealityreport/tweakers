import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  findGeneratedConflictCopies,
  publishGeneratedDirectorySync,
  replaceGeneratedFileSync,
} from "./generated-assets.mjs";

function snapshot(root) {
  const rows = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        rows.push([name, "directory", statSync(path).mode & 0o777]);
        visit(path);
      } else {
        rows.push([name, "file", statSync(path).mode & 0o777, readFileSync(path).toString("base64")]);
      }
    }
  };
  visit(root);
  return rows;
}

test("staging rejects conflict-copy names before mutating the prior destination", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-generated-assets-"));
  const destination = join(root, "runtime");
  try {
    mkdirSync(destination);
    writeFileSync(join(destination, "current.js"), "prior\n");
    chmodSync(join(destination, "current.js"), 0o750);
    const priorInode = statSync(join(destination, "current.js")).ino;

    assert.throws(() => publishGeneratedDirectorySync(destination, (staged) => {
      mkdirSync(staged);
      writeFileSync(join(staged, "main.js"), "canonical\n");
      writeFileSync(join(staged, "main 10.js"), "conflict\n");
    }), /conflict copies/);

    assert.equal(readFileSync(join(destination, "current.js"), "utf8"), "prior\n");
    assert.equal(statSync(join(destination, "current.js")).mode & 0o777, 0o750);
    assert.equal(statSync(join(destination, "current.js")).ino, priorInode);
    assert.equal(existsSync(join(destination, "main.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unchanged files and directories retain inodes while only changed files are atomically replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-generated-inodes-"));
  const destination = join(root, "runtime");
  const populate = (staged) => {
    mkdirSync(join(staged, "nested"), { recursive: true });
    writeFileSync(join(staged, "nested", "keep.js"), "keep\n");
    writeFileSync(join(staged, "changed.js"), "new\n");
  };
  try {
    mkdirSync(join(destination, "nested"), { recursive: true });
    writeFileSync(join(destination, "nested", "keep.js"), "keep\n");
    writeFileSync(join(destination, "changed.js"), "old\n");
    writeFileSync(join(destination, "stale.js"), "stale\n");
    const before = {
      root: statSync(destination).ino,
      nested: statSync(join(destination, "nested")).ino,
      keep: statSync(join(destination, "nested", "keep.js")).ino,
      changed: statSync(join(destination, "changed.js")).ino,
    };

    const first = publishGeneratedDirectorySync(destination, populate);
    assert.ok(first.mutationCount >= 2);
    assert.equal(statSync(destination).ino, before.root);
    assert.equal(statSync(join(destination, "nested")).ino, before.nested);
    assert.equal(statSync(join(destination, "nested", "keep.js")).ino, before.keep);
    assert.notEqual(statSync(join(destination, "changed.js")).ino, before.changed);
    assert.equal(existsSync(join(destination, "stale.js")), false);

    const stable = {
      root: statSync(destination).ino,
      nested: statSync(join(destination, "nested")).ino,
      keep: statSync(join(destination, "nested", "keep.js")).ino,
      changed: statSync(join(destination, "changed.js")).ino,
    };
    const second = publishGeneratedDirectorySync(destination, populate);
    assert.equal(second.mutationCount, 0);
    assert.deepEqual({
      root: statSync(destination).ino,
      nested: statSync(join(destination, "nested")).ino,
      keep: statSync(join(destination, "nested", "keep.js")).ino,
      changed: statSync(join(destination, "changed.js")).ino,
    }, stable);
    assert.deepEqual(findGeneratedConflictCopies(destination), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a populate failure leaves the complete prior generated directory untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-generated-failure-"));
  const destination = join(root, "runtime");
  try {
    mkdirSync(join(destination, "nested"), { recursive: true });
    writeFileSync(join(destination, "nested", "current.js"), "prior\n");
    const prior = snapshot(destination);
    assert.throws(() => publishGeneratedDirectorySync(destination, (staged) => {
      mkdirSync(staged);
      writeFileSync(join(staged, "partial.js"), "partial\n");
      throw new Error("simulated generation failure");
    }), /simulated generation failure/);
    assert.deepEqual(snapshot(destination), prior);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a multi-file partial publication failure restores changed, new, and stale paths", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-generated-publish-failure-"));
  const destination = join(root, "runtime");
  try {
    mkdirSync(destination);
    writeFileSync(join(destination, "a.js"), "old a\n");
    writeFileSync(join(destination, "b.js"), "old b\n");
    writeFileSync(join(destination, "stale.js"), "old stale\n");
    chmodSync(join(destination, "b.js"), 0o750);
    const prior = snapshot(destination);
    const priorInodes = {
      a: statSync(join(destination, "a.js")).ino,
      b: statSync(join(destination, "b.js")).ino,
      stale: statSync(join(destination, "stale.js")).ino,
    };

    assert.throws(() => publishGeneratedDirectorySync(destination, (staged) => {
      mkdirSync(staged);
      writeFileSync(join(staged, "a.js"), "new a\n");
      writeFileSync(join(staged, "b.js"), "new b\n");
      writeFileSync(join(staged, "new.js"), "new file\n");
    }, {
      afterMutation: ({ mutationCount }) => {
        // a + b replacements, new-file creation, then stale removal.
        if (mutationCount === 4) throw new Error("simulated publication failure");
      },
    }), /simulated publication failure/);

    assert.deepEqual(snapshot(destination), prior);
    assert.deepEqual({
      a: statSync(join(destination, "a.js")).ino,
      b: statSync(join(destination, "b.js")).ino,
      stale: statSync(join(destination, "stale.js")).ino,
    }, priorInodes);
    assert.equal(existsSync(join(destination, "new.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-commit workspace cleanup errors do not report a false publication failure", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-generated-cleanup-failure-"));
  const destination = join(root, "runtime");
  const cleanupEvents = [];
  try {
    mkdirSync(destination);
    writeFileSync(join(destination, "main.js"), "old\n");
    const result = publishGeneratedDirectorySync(destination, (staged) => {
      mkdirSync(staged);
      writeFileSync(join(staged, "main.js"), "new\n");
    }, {
      cleanupWorkspace: () => { throw new Error("simulated workspace cleanup failure"); },
      onCleanupError: (error, context) => cleanupEvents.push([error.message, context.committed]),
    });
    assert.equal(result.mutationCount, 1);
    assert.equal(readFileSync(join(destination, "main.js"), "utf8"), "new\n");
    assert.deepEqual(cleanupEvents, [["simulated workspace cleanup failure", true]]);

    const source = join(root, "source.cjs");
    const target = join(root, "target.cjs");
    writeFileSync(source, "new loader\n");
    writeFileSync(target, "old loader\n");
    const fileCleanupEvents = [];
    assert.equal(replaceGeneratedFileSync(source, target, {
      cleanupWorkspace: () => { throw new Error("simulated file cleanup failure"); },
      onCleanupError: (error, context) => fileCleanupEvents.push([error.message, context.committed]),
    }), true);
    assert.equal(readFileSync(target, "utf8"), "new loader\n");
    assert.deepEqual(fileCleanupEvents, [["simulated file cleanup failure", true]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

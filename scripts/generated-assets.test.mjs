import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  findGeneratedConflictCopies,
  publishGeneratedDirectorySync,
  replaceGeneratedFileSync,
} from "./generated-assets.mjs";
import { publishNativeManager } from "../packages/runtime/scripts/copy-native-host.mjs";

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

test("protected hard-link journal falls back to a verified copy before publication", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-copy-journal-"));
  const destination = join(root, "runtime");
  let backup;
  try {
    mkdirSync(destination);
    const target = join(destination, "main.js");
    writeFileSync(target, "old\n");
    chmodSync(target, 0o750);
    utimesSync(target, 1_700_000_000, 1_700_000_001);
    const result = publishGeneratedDirectorySync(destination, staged => {
      mkdirSync(staged);
      writeFileSync(join(staged, "main.js"), "new\n");
    }, {
      linkJournalFile: () => { throw Object.assign(new Error("protected hard link"), { code: "EPERM" }); },
      copyJournalFile: (source, copied, options) => { backup = copied; cpSync(source, copied, options); },
      afterMutation: () => {
        assert.equal(readFileSync(backup, "utf8"), "old\n");
        assert.equal(statSync(backup).mode & 0o777, 0o750);
        assert.ok(Math.abs(statSync(backup).mtimeMs - 1_700_000_001_000) < 1);
        assert.notEqual(statSync(backup).ino, statSync(target).ino);
      },
    });
    assert.equal(result.mutationCount, 1);
    assert.equal(readFileSync(target, "utf8"), "new\n");
    assert.equal(existsSync(backup), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("protected hard-link copy journal restores bytes and modes after later failure", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-copy-journal-rollback-"));
  const destination = join(root, "runtime");
  try {
    mkdirSync(destination);
    writeFileSync(join(destination, "a.js"), "old a\n");
    writeFileSync(join(destination, "b.js"), "old b\n");
    chmodSync(join(destination, "b.js"), 0o750);
    const prior = snapshot(destination);
    const oldInode = statSync(join(destination, "a.js")).ino;
    assert.throws(() => publishGeneratedDirectorySync(destination, staged => {
      mkdirSync(staged);
      writeFileSync(join(staged, "a.js"), "new a\n");
      writeFileSync(join(staged, "b.js"), "new b\n");
    }, {
      linkJournalFile: () => { throw Object.assign(new Error("protected hard link"), { code: "EPERM" }); },
      afterMutation: ({ mutationCount }) => { if (mutationCount === 2) throw new Error("later publication failure"); },
    }), /later publication failure/);
    assert.deepEqual(snapshot(destination), prior);
    assert.notEqual(statSync(join(destination, "a.js")).ino, oldInode, "copy fallback preserves contents, not the unsupported old inode");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("protected hard-link journal copy failure leaves the prior file untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-copy-journal-failure-"));
  const destination = join(root, "runtime");
  try {
    mkdirSync(destination);
    const target = join(destination, "main.js");
    writeFileSync(target, "old\n");
    const priorInode = statSync(target).ino;
    assert.throws(() => publishGeneratedDirectorySync(destination, staged => {
      mkdirSync(staged);
      writeFileSync(join(staged, "main.js"), "new\n");
    }, {
      linkJournalFile: () => { throw Object.assign(new Error("protected hard link"), { code: "EPERM" }); },
      copyJournalFile: () => { throw new Error("copy unavailable"); },
      afterMutation: () => assert.fail("unverified backup must not allow mutation"),
    }), /copy unavailable/);
    assert.equal(readFileSync(target, "utf8"), "old\n");
    assert.equal(statSync(target).ino, priorInode);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const changed of ["bytes", "mode"]) {
  test(`protected hard-link journal rejects mismatched backup ${changed} before mutation`, () => {
    const root = mkdtempSync(join(tmpdir(), "tweakers-copy-journal-mismatch-"));
    const destination = join(root, "runtime");
    try {
      mkdirSync(destination);
      const target = join(destination, "main.js");
      writeFileSync(target, "old\n");
      chmodSync(target, 0o750);
      const priorInode = statSync(target).ino;
      assert.throws(() => publishGeneratedDirectorySync(destination, staged => {
        mkdirSync(staged);
        writeFileSync(join(staged, "main.js"), "new\n");
      }, {
        linkJournalFile: () => { throw Object.assign(new Error("protected hard link"), { code: "EPERM" }); },
        copyJournalFile: (_source, copied) => {
          writeFileSync(copied, changed === "bytes" ? "wrong\n" : "old\n");
          chmodSync(copied, changed === "mode" ? 0o644 : 0o750);
        },
        afterMutation: () => assert.fail("unverified backup must not allow mutation"),
      }), /copy journal does not match/);
      assert.equal(readFileSync(target, "utf8"), "old\n");
      assert.equal(statSync(target).mode & 0o777, 0o750);
      assert.equal(statSync(target).ino, priorInode);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("hard-link journal propagates unexpected link errors without copying", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-link-journal-unexpected-"));
  const destination = join(root, "runtime");
  try {
    mkdirSync(destination);
    writeFileSync(join(destination, "main.js"), "old\n");
    assert.throws(() => publishGeneratedDirectorySync(destination, staged => {
      mkdirSync(staged);
      writeFileSync(join(staged, "main.js"), "new\n");
    }, {
      linkJournalFile: () => { throw Object.assign(new Error("access denied"), { code: "EACCES" }); },
      copyJournalFile: () => assert.fail("only EPERM selects copy fallback"),
    }), /access denied/);
    assert.equal(readFileSync(join(destination, "main.js"), "utf8"), "old\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed rollback retains its recovery journal and private action manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-journal-retention-"));
  const destination = join(root, "runtime");
  let cleanupCalled = false;
  const events = [];
  try {
    mkdirSync(destination);
    writeFileSync(join(destination, "a.js"), "old\n");
    assert.throws(() => publishGeneratedDirectorySync(destination, staged => {
      mkdirSync(staged);
      writeFileSync(join(staged, "a.js"), "new\n");
      writeFileSync(join(staged, "b.js"), "new file\n");
    }, {
      linkJournalFile: () => { throw Object.assign(new Error("protected hard link"), { code: "EPERM" }); },
      rename: (source, target) => {
        if (source.includes("/journal/")) throw new Error("restore blocked");
        renameSync(source, target);
      },
      afterMutation: ({ mutationCount }) => { if (mutationCount === 2) throw new Error("later publication failure"); },
      cleanupWorkspace: () => { cleanupCalled = true; },
      onCleanupError: (_error, context) => events.push(context),
    }), error => error instanceof AggregateError && /publication and rollback failed/.test(error.message));
    assert.equal(cleanupCalled, false);
    assert.equal(events.length, 1);
    const workspace = events[0].workspace;
    assert.equal(events[0].rollbackFailed, true);
    assert.equal(statSync(workspace).mode & 0o777, 0o700);
    const manifestPath = join(workspace, "recovery.json");
    assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
    const recovery = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(recovery.destination, destination);
    assert.equal(recovery.committed, false);
    assert.equal(recovery.failedRollbackActions.length, 1);
    assert.equal(recovery.failedRollbackActions[0].path, join(destination, "a.js"));
    assert.equal(readFileSync(recovery.failedRollbackActions[0].backup, "utf8"), "old\n");
    assert.equal(existsSync(join(destination, "b.js")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test("Manager publication skips non-macOS and publishes an initial verified bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-initial-"));
  const source = join(root, "source.app");
  const destination = join(root, "native", "Tweakers Manager.app");
  try {
    mkdirSync(source);
    writeFileSync(join(source, "value"), "new");
    assert.equal(publishNativeManager({ source, destination, platform: "linux" }).skipped, true);
    assert.equal(existsSync(destination), false);
    const result = publishNativeManager({ source, destination, platform: "darwin", verify: () => {} });
    assert.equal(result.published, true);
    assert.equal(readFileSync(join(destination, "value"), "utf8"), "new");
    assert.deepEqual(result.retainedArtifacts, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Manager replacement swaps verified candidate and retires legacy names only afterward", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-replace-"));
  const source = join(root, "source.app");
  const destination = join(root, "native", "Tweakers Manager.app");
  const legacy = join(root, "native", "Tweakers Doctor.app");
  try {
    mkdirSync(source);
    mkdirSync(destination, { recursive: true });
    mkdirSync(legacy);
    writeFileSync(join(source, "value"), "new");
    writeFileSync(join(destination, "value"), "old");
    let sawVerifiedCandidate = false;
    const result = publishNativeManager({ source, destination, platform: "darwin",
      verify: (candidate) => { sawVerifiedCandidate = readFileSync(join(candidate, "value"), "utf8") === "new"; },
      swap: (candidate, current) => {
        assert.equal(sawVerifiedCandidate, true);
        assert.equal(existsSync(legacy), true);
        const displaced = `${candidate}.swap`;
        renameSync(current, displaced);
        renameSync(candidate, current);
        renameSync(displaced, candidate);
      },
    });
    assert.equal(readFileSync(join(destination, "value"), "utf8"), "new");
    assert.equal(existsSync(legacy), false);
    assert.deepEqual(result.retainedArtifacts, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Manager copy, signature, and unavailable swap failures preserve the prior bundle and legacy names", () => {
  for (const failure of ["copy", "signature", "swap"]) {
    const root = mkdtempSync(join(tmpdir(), `tweakers-manager-${failure}-`));
    const source = join(root, "source.app");
    const destination = join(root, "native", "Tweakers Manager.app");
    const legacy = join(root, "native", "Tweakers Doctor.app");
    try {
      mkdirSync(source);
      mkdirSync(destination, { recursive: true });
      mkdirSync(legacy);
      writeFileSync(join(source, "value"), "new");
      writeFileSync(join(destination, "value"), "old");
      assert.throws(() => publishNativeManager({ source, destination, platform: "darwin",
        copy: failure === "copy" ? () => { throw new Error("copy failed"); } : cpSync,
        verify: failure === "signature" ? () => { throw new Error("signature failed"); } : () => {},
        swap: () => { throw new Error("swap unavailable"); },
      }), /copy failed|signature failed|swap unavailable/);
      assert.equal(readFileSync(join(destination, "value"), "utf8"), "old");
      assert.equal(existsSync(legacy), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Manager cleanup failure reports retained displaced and legacy bundles after publication", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-cleanup-"));
  const source = join(root, "source.app");
  const destination = join(root, "native", "Tweakers Manager.app");
  const legacy = join(root, "native", "Tweakers Doctor.app");
  try {
    mkdirSync(source);
    mkdirSync(destination, { recursive: true });
    mkdirSync(legacy);
    writeFileSync(join(source, "value"), "new");
    writeFileSync(join(destination, "value"), "old");
    const result = publishNativeManager({ source, destination, platform: "darwin", verify: () => {},
      swap: (candidate, current) => {
        const displaced = `${candidate}.swap`;
        renameSync(current, displaced);
        renameSync(candidate, current);
        renameSync(displaced, candidate);
      },
      remove: (path, options) => {
        if (path === legacy || path.includes(".candidate-")) throw new Error("cleanup denied");
        rmSync(path, options);
      },
    });
    assert.equal(readFileSync(join(destination, "value"), "utf8"), "new");
    assert.equal(result.retainedArtifacts.includes(legacy), true);
    assert.equal(result.retainedArtifacts.some((path) => path.includes(".candidate-")), true);
    assert.equal(result.retainedArtifacts.every((path) => existsSync(path)), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

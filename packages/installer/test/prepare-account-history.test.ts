import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatPrepareAccountHistoryResult,
  prepareAccountHistoryCommand,
} from "../src/commands/prepare-account-history.ts";
import type {
  PrivateHistoryNormalizationInput,
  PrivateHistoryNormalizationResult,
} from "../src/private-history-normalization.ts";

const DRY_RUN_RESULT: PrivateHistoryNormalizationResult = {
  status: "dry-run",
  sourceFingerprint: `sha256:${"a".repeat(64)}`,
  normalizedFingerprint: null,
  regularHistoryFiles: 1204,
  linkedHistoryFiles: 308,
  historyBytes: 717_419_190,
  databaseThreadCount: 7603,
  importedThreadCount: 7603,
  rewrittenRolloutPaths: 1512,
  clearedMissingRolloutPaths: 6091,
  recoveredSourceStaleRolloutPaths: 2,
  recoveredArchiveRolloutPaths: 5,
  decompressedArchiveFiles: 3,
  decompressedArchiveBytes: 2048,
  excludedMetadataFiles: 4,
  databasesPresent: 6,
  sessionIndexPresent: true,
  nextAction: "apply-normalization",
};

test("prepare-account-history defaults to a redacted dry run with exact private roots", () => {
  let captured: PrivateHistoryNormalizationInput | null = null;
  const output: string[] = [];
  const result = prepareAccountHistoryCommand({
    "allowed-link-root": "/Volumes/Approved Archive",
  }, {
    home: () => "/Users/example",
    userRoot: () => "/Users/example/Library/Application Support/tweakers",
    execute(input) {
      captured = input;
      return DRY_RUN_RESULT;
    },
    print: (line) => output.push(line),
  });

  assert.deepEqual(captured, {
    sourceCodexRoot: "/Users/example/.codex",
    sourceSqliteRoot: "/Users/example/.codex",
    snapshotRoot: "/Users/example/Library/Application Support/tweakers/private-account-history-source-v1",
    allowedLinkRoot: "/Volumes/Approved Archive",
    appPath: "/Applications/Tweakers.app",
    forbiddenRoots: [
      "/Users/example/Library/Application Support/tweakers/tweak-data",
      "/Users/example/Library/Application Support/tweakers/account-router",
      "/Users/example/Library/Application Support/tweakers/accounts",
    ],
    apply: false,
  });
  assert.equal(result.status, "dry-run");
  assert.deepEqual(JSON.parse(output[0]!), formatPrepareAccountHistoryResult(DRY_RUN_RESULT));
  assert.equal(JSON.parse(output[0]!).recoveredArchiveRolloutPaths, 5);
  assert.equal(JSON.parse(output[0]!).decompressedArchiveBytes, 2048);
  assert.doesNotMatch(output[0]!, /Users|Volumes|01a055/);
});

test("prepare-account-history requires an explicit approved link root", () => {
  assert.throws(() => prepareAccountHistoryCommand({}, {
    home: () => "/Users/example",
    userRoot: () => "/Users/example/Library/Application Support/tweakers",
    execute: () => DRY_RUN_RESULT,
    print: () => undefined,
  }), /requires --allowed-link-root/);
});

test("--dry-run overrides --apply and exact source roots are preserved", () => {
  let captured: PrivateHistoryNormalizationInput | null = null;
  prepareAccountHistoryCommand({
    apply: true,
    "dry-run": true,
    "source-codex-root": "/private/source-codex",
    "source-sqlite-root": "/private/source-sqlite",
    "allowed-link-root": "/private/archive",
  }, {
    userRoot: () => "/private/user-root",
    execute(input) {
      captured = input;
      return DRY_RUN_RESULT;
    },
    print: () => undefined,
  });
  assert.equal(captured?.apply, false);
  assert.equal(captured?.sourceCodexRoot, "/private/source-codex");
  assert.equal(captured?.sourceSqliteRoot, "/private/source-sqlite");
  assert.equal(captured?.snapshotRoot, "/private/user-root/private-account-history-source-v1");
  assert.equal(captured?.allowedLinkRoot, "/private/archive");
  assert.equal(captured?.appPath, "/Applications/Tweakers.app");
});

test("explicit roots must already be exact absolute paths", () => {
  const values = [
    "relative/path",
    "./relative/path",
    "/private/source/../source",
    " /private/source",
    "/private/source ",
  ];
  for (const value of values) {
    assert.throws(() => prepareAccountHistoryCommand({
      "source-codex-root": value,
      "allowed-link-root": "/private/archive",
    }, {
      userRoot: () => "/private/user-root",
      execute: () => DRY_RUN_RESULT,
      print: () => undefined,
    }), /--source-codex-root must be an exact absolute path/);
  }
  assert.throws(() => prepareAccountHistoryCommand({
    "allowed-link-root": "relative/archive",
  }, {
    userRoot: () => "/private/user-root",
    execute: () => DRY_RUN_RESULT,
    print: () => undefined,
  }), /--allowed-link-root must be an exact absolute path/);
});

test("CLI callers cannot redirect the fixed snapshot or trusted app identity", () => {
  const captured: PrivateHistoryNormalizationInput[] = [];
  prepareAccountHistoryCommand({
    "allowed-link-root": "/private/archive",
  }, {
    userRoot: () => "/private/trusted-user-root",
    execute(input) {
      captured.push(input);
      return DRY_RUN_RESULT;
    },
    print: () => undefined,
  });
  assert.equal(captured[0]?.snapshotRoot, "/private/trusted-user-root/private-account-history-source-v1");
  assert.equal(captured[0]?.appPath, "/Applications/Tweakers.app");
  assert.equal(Object.hasOwn(captured[0] ?? {}, "snapshot-root"), false);
  assert.equal(Object.hasOwn(captured[0] ?? {}, "app"), false);
});

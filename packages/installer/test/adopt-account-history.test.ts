import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptAccountHistoryCommand,
  formatAdoptAccountHistoryResult,
} from "../src/commands/adopt-account-history.ts";
import type {
  AdoptAccountHistoryInput,
  HistoryAdoptionResult,
} from "../src/account-history-adoption.ts";

const result: HistoryAdoptionResult = {
  status: "dry-run",
  importedThreadCount: 2,
  sourceFingerprint: `sha256:${"1".repeat(64)}`,
  destinationFingerprint: null,
  poolFingerprint: `sha256:${"2".repeat(64)}`,
  intentFingerprint: `sha256:${"3".repeat(64)}`,
  databasesPresent: 6,
  historyFiles: 4,
  nextAction: "review-and-apply",
};

test("adopt-account-history defaults to dry run and resolves defaults only when invoked", () => {
  let captured: AdoptAccountHistoryInput | undefined;
  const output: string[] = [];
  const actual = adoptAccountHistoryCommand({}, {
    home: () => "/synthetic/home",
    userRoot: () => "/synthetic/user-root",
    execute: (input) => {
      captured = input;
      return result;
    },
    print: (line) => output.push(line),
  });

  assert.equal(actual, result);
  assert.deepEqual(captured, {
    sourceCodexRoot: "/synthetic/home/.codex",
    sourceSqliteRoot: "/synthetic/home/.codex",
    routerRoot: "/synthetic/user-root/tweak-data/co.tweakers.account-switcher",
    appPath: "/Applications/ChatGPT.app",
    apply: false,
  });
  assert.deepEqual(JSON.parse(output[0]!), formatAdoptAccountHistoryResult(result));
});

test("apply is explicit and --dry-run wins over --apply", () => {
  const seen: AdoptAccountHistoryInput[] = [];
  const execute = (input: AdoptAccountHistoryInput): HistoryAdoptionResult => {
    seen.push(input);
    return result;
  };
  const common = {
    sourceCodexRoot: "/synthetic/legacy/codex",
    sourceSqliteRoot: "/synthetic/legacy/sqlite",
    routerRoot: "/synthetic/router",
    app: "/synthetic/ChatGPT.app",
  };

  adoptAccountHistoryCommand({ ...common, apply: true }, { execute, print: () => undefined });
  adoptAccountHistoryCommand({ ...common, apply: true, "dry-run": true }, { execute, print: () => undefined });

  assert.equal(seen[0]?.apply, true);
  assert.equal(seen[1]?.apply, false);
  assert.equal(seen[0]?.sourceCodexRoot, common.sourceCodexRoot);
  assert.equal(seen[0]?.sourceSqliteRoot, common.sourceSqliteRoot);
  assert.equal(seen[0]?.routerRoot, common.routerRoot);
  assert.equal(seen[0]?.appPath, common.app);
});

test("CLI formatter exposes only redacted evidence fields", () => {
  const withPrivateExtras = {
    ...result,
    legacyOwnerOpaqueAccountId: `ar_${"a".repeat(43)}`,
    sourcePath: "/synthetic/legacy/codex/auth.json",
    threadId: "01a05546-cf93-7383-96ed-dc76ce3d1b3c",
  } as HistoryAdoptionResult & Record<string, string>;
  const output = JSON.stringify(formatAdoptAccountHistoryResult(withPrivateExtras));

  assert.doesNotMatch(output, /ar_[A-Za-z0-9_-]+/);
  assert.doesNotMatch(output, /legacy\/codex|auth\.json|01a05546/);
  assert.deepEqual(Object.keys(JSON.parse(output)).sort(), [
    "databasesPresent",
    "destinationFingerprint",
    "historyFiles",
    "importedThreadCount",
    "intentFingerprint",
    "nextAction",
    "poolFingerprint",
    "sourceFingerprint",
    "state",
  ]);
});

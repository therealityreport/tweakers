import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  normalizePrivateHistory,
  type PrivateHistoryNormalizationDependencies,
  type PrivateHistoryNormalizationInput,
  type PrivateHistoryNormalizationResult,
} from "../private-history-normalization.js";
import { userPaths } from "../paths.js";

export interface PrepareAccountHistoryCliOptions {
  apply?: boolean;
  dryRun?: boolean;
  "dry-run"?: boolean;
  sourceCodexRoot?: string;
  "source-codex-root"?: string;
  sourceSqliteRoot?: string;
  "source-sqlite-root"?: string;
  allowedLinkRoot?: string;
  "allowed-link-root"?: string;
}

export interface PrepareAccountHistoryCommandDependencies {
  execute?: (
    input: PrivateHistoryNormalizationInput,
    dependencies?: Partial<PrivateHistoryNormalizationDependencies>,
  ) => PrivateHistoryNormalizationResult;
  normalizationDependencies?: Partial<PrivateHistoryNormalizationDependencies>;
  userRoot?: () => string;
  home?: () => string;
  print?: (line: string) => void;
}

/**
 * Plans or creates the private source snapshot consumed by the separate,
 * existing adopt-account-history command. It never starts adoption itself.
 */
export function prepareAccountHistoryCommand(
  options: PrepareAccountHistoryCliOptions = {},
  dependencies: PrepareAccountHistoryCommandDependencies = {},
): PrivateHistoryNormalizationResult {
  const home = dependencies.home?.() ?? homedir();
  const userRoot = resolve(dependencies.userRoot?.() ?? userPaths().root);
  const sourceCodexValue = options.sourceCodexRoot ?? options["source-codex-root"];
  const sourceCodexRoot = sourceCodexValue === undefined
    ? resolve(join(home, ".codex"))
    : exactCliPath(sourceCodexValue, "--source-codex-root");
  const sourceSqliteValue = options.sourceSqliteRoot ?? options["source-sqlite-root"];
  const sourceSqliteRoot = sourceSqliteValue === undefined
    ? sourceCodexRoot
    : exactCliPath(sourceSqliteValue, "--source-sqlite-root");
  // Publication is intentionally fixed to one dedicated namespace under the
  // trusted Tweakers user root. A CLI caller cannot redirect private history
  // into a repository, app bundle, account home, or arbitrary directory.
  const snapshotRoot = join(userRoot, "private-account-history-source-v1");
  const allowedLinkValue = options.allowedLinkRoot ?? options["allowed-link-root"];
  if (typeof allowedLinkValue !== "string" || allowedLinkValue.trim().length === 0) {
    throw new Error("prepare-account-history requires --allowed-link-root");
  }
  const allowedLinkRoot = exactCliPath(allowedLinkValue, "--allowed-link-root");
  // The normalizer treats this trusted identity additively with every
  // supported ChatGPT/Codex/Tweakers app identity. It is not user-overridable.
  const appPath = "/Applications/Tweakers.app";
  const apply = options.apply === true && options.dryRun !== true && options["dry-run"] !== true;
  const result = (dependencies.execute ?? normalizePrivateHistory)({
    sourceCodexRoot,
    sourceSqliteRoot,
    snapshotRoot,
    allowedLinkRoot,
    appPath,
    forbiddenRoots: [
      join(userRoot, "tweak-data"),
      join(userRoot, "account-router"),
      join(userRoot, "accounts"),
    ],
    apply,
  }, dependencies.normalizationDependencies);
  (dependencies.print ?? console.log)(JSON.stringify(formatPrepareAccountHistoryResult(result)));
  return result;
}

function exactCliPath(value: string, option: string): string {
  if (value.trim() !== value || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${option} must be an exact absolute path`);
  }
  return value;
}

/** Only counts, fingerprints, state, and the next action cross the CLI. */
export function formatPrepareAccountHistoryResult(
  result: PrivateHistoryNormalizationResult,
): Record<string, unknown> {
  return {
    state: result.status,
    sourceFingerprint: result.sourceFingerprint,
    normalizedFingerprint: result.normalizedFingerprint,
    regularHistoryFiles: result.regularHistoryFiles,
    linkedHistoryFiles: result.linkedHistoryFiles,
    historyBytes: result.historyBytes,
    databaseThreadCount: result.databaseThreadCount,
    importedThreadCount: result.importedThreadCount,
    rewrittenRolloutPaths: result.rewrittenRolloutPaths,
    clearedMissingRolloutPaths: result.clearedMissingRolloutPaths,
    recoveredSourceStaleRolloutPaths: result.recoveredSourceStaleRolloutPaths,
    recoveredArchiveRolloutPaths: result.recoveredArchiveRolloutPaths,
    decompressedArchiveFiles: result.decompressedArchiveFiles,
    decompressedArchiveBytes: result.decompressedArchiveBytes,
    excludedMetadataFiles: result.excludedMetadataFiles,
    databasesPresent: result.databasesPresent,
    sessionIndexPresent: result.sessionIndexPresent,
    nextAction: result.nextAction,
  };
}

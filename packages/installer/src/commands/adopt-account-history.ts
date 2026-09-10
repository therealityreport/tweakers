import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  adoptAccountHistory,
  type AdoptAccountHistoryInput,
  type HistoryAdoptionDependencies,
  type HistoryAdoptionResult,
} from "../account-history-adoption.js";
import { userPaths } from "../paths.js";

export interface AdoptAccountHistoryCliOptions {
  apply?: boolean;
  dryRun?: boolean;
  "dry-run"?: boolean;
  sourceCodexRoot?: string;
  "source-codex-root"?: string;
  sourceSqliteRoot?: string;
  "source-sqlite-root"?: string;
  routerRoot?: string;
  "router-root"?: string;
  app?: string;
}

export interface AdoptAccountHistoryCommandDependencies {
  execute?: (input: AdoptAccountHistoryInput, dependencies?: Partial<HistoryAdoptionDependencies>) => HistoryAdoptionResult;
  adoptionDependencies?: Partial<HistoryAdoptionDependencies>;
  userRoot?: () => string;
  home?: () => string;
  print?: (line: string) => void;
}

/**
 * Defaults to a dry run. This command consumes the Accounts-owned signed
 * intent; it deliberately has no owner-ID option and cannot create intent.
 */
export function adoptAccountHistoryCommand(
  options: AdoptAccountHistoryCliOptions = {},
  dependencies: AdoptAccountHistoryCommandDependencies = {},
): HistoryAdoptionResult {
  const home = dependencies.home?.() ?? homedir();
  const userRoot = dependencies.userRoot?.() ?? userPaths().root;
  const sourceCodexRoot = resolve(options.sourceCodexRoot ?? options["source-codex-root"] ?? join(home, ".codex"));
  const sourceSqliteRoot = resolve(options.sourceSqliteRoot ?? options["source-sqlite-root"] ?? sourceCodexRoot);
  const routerRoot = resolve(options.routerRoot ?? options["router-root"] ?? join(userRoot, "tweak-data", "co.tweakers.account-switcher"));
  const apply = options.apply === true && options.dryRun !== true && options["dry-run"] !== true;
  const result = (dependencies.execute ?? adoptAccountHistory)({
    sourceCodexRoot,
    sourceSqliteRoot,
    routerRoot,
    appPath: resolve(options.app ?? "/Applications/ChatGPT.app"),
    apply,
  }, dependencies.adoptionDependencies);
  (dependencies.print ?? console.log)(JSON.stringify(formatAdoptAccountHistoryResult(result)));
  return result;
}

/** Only status/counts/fingerprints/next action cross the CLI boundary. */
export function formatAdoptAccountHistoryResult(result: HistoryAdoptionResult): Record<string, unknown> {
  return {
    state: result.status,
    importedThreadCount: result.importedThreadCount,
    sourceFingerprint: result.sourceFingerprint,
    destinationFingerprint: result.destinationFingerprint,
    poolFingerprint: result.poolFingerprint,
    intentFingerprint: result.intentFingerprint,
    databasesPresent: result.databasesPresent,
    historyFiles: result.historyFiles,
    nextAction: result.nextAction,
  };
}

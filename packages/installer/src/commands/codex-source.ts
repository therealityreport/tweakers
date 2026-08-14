import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  CODEX_DERIVED_RECEIPT_SCHEMA_VERSION,
  codexDerivedLabel,
  createCodexResolutionCycle,
  isCodexDerivedReceipt,
  readCodexDerivedReceipt,
  recordCodexResolutionCheckpoint,
  resolutionEvidenceFromCycle,
  writeCodexDerivedReceipt,
  type ArtifactEvidence,
  type CodexCanaryEvidenceReference,
  type CodexDerivedReceipt,
  type CodexResolutionCheckpoint,
  type CodexResolutionCycleState,
  type FrontendControlEvidence,
  type LockedDependencyEvidence,
  type CodexRustLifecycleTestEvidence,
  type RestartWindow,
  type WatcherPromotionEvidence,
  type CodexSourceEvidence,
} from "../codex-derived-receipt.js";
import {
  CODEX_GITHUB_API_VERSION,
  CODEX_RELEASE_REPOSITORY,
  assertChannelPromotionAllowed,
  assertNpmDoesNotLead,
  compareSemverPrecedence,
  detectCodexReleaseAdvisory,
  evaluateNpmAgreement,
  parseCodexReleaseTag,
  parseSemver,
  peelCodexTag,
  resolveCodexSourceRelease,
  type AdvisoryDetectionResult,
  type ChannelPromotionFloor,
  type CodexSourceChannel,
  type GitHubJsonFetcher,
  type GitHubJsonRequest,
  type GitHubJsonResponse,
  type GitObjectIdentity,
  type NpmAgreement,
  type TagPeelIdentity,
} from "../codex-source-release.js";
import {
  stageCodexManagedMcpPackages,
  type ManagedMcpStageEvidence,
  type StageCodexManagedMcpPackagesOptions,
} from "../managed-mcp-packages.js";
import {
  attestManagedMcpArtifact,
  assertManagedMcpPreparedRuntimeEvidence,
  installManagedMcpPreparedRuntime,
  prepareManagedMcpLifecycleRuntime,
  readAndVerifyManagedMcpLifecycleOverlay,
  type ManagedMcpPreparedRuntimeEvidence,
  type PrepareManagedMcpLifecycleInput,
} from "../managed-mcp-lifecycle.js";
import { userPaths } from "../paths.js";
import { locateCodex, locateCodexAtExactPath } from "../platform.js";
import { readPlist } from "../plist.js";
import { assertInternalStoragePath as assertInternalFilesystemPath } from "../internal-storage.js";
import { signCodexApp, signatureInfo, verifySignature } from "../codesign.js";
import { buildPatchedCandidateOnly } from "./install.js";
import {
  assertManagedMcpCanaryEvidence,
  runManagedMcpCanary,
  sha256TrustedManagedMcpCanaryRunnerSource,
  trustedManagedMcpCanaryRunnerSourcePath,
  writeManagedMcpCanaryEvidence,
  type ManagedMcpCanaryExpectedRoute,
  type ManagedMcpCanaryEvidence,
  type ManagedMcpCanaryObservationAdapter,
  type ManagedMcpCanaryRunInput,
} from "../managed-mcp-canary-runner.js";
import {
  createManagedMcpAppServerObservationAdapter,
  sha256TrustedManagedMcpAppServerAdapterSource,
  trustedManagedMcpAppServerAdapterSourcePath,
} from "../managed-mcp-canary-app-server-adapter.js";
import {
  executeCodexSourceCutover,
  rollbackCodexSourceCutover,
  type CodexSourceCutoverReceipt,
} from "../codex-source-cutover.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
const CODEX_GIT_URL = "https://github.com/openai/codex.git";
const NPM_CODEX_ENDPOINT = "https://registry.npmjs.org/@openai%2Fcodex";
const DAILY_CHECK_MS = 24 * 60 * 60 * 1_000;
const STOCK_CHATGPT_APP = "/Applications/ChatGPT.app";
const MINIMUM_BUILD_FREE_BYTES = 40n * 1024n * 1024n * 1024n;

export type CodexSourceAction = "build" | "canary-pass" | "freeze" | "cutover" | "rollback" | "detect" | "resolve" | "status";

export interface CodexSourceOptions {
  app?: string;
  channel?: string;
  json?: boolean;
  force?: boolean;
  frontendSourceApp?: string;
  "frontend-source-app"?: string;
  patchSeries?: string | readonly string[];
  "patch-series"?: string | readonly string[];
  chromePluginRoot?: string;
  "chrome-plugin-root"?: string;
  playwrightPluginRoot?: string;
  "playwright-plugin-root"?: string;
  fleetManifest?: string;
  "fleet-manifest"?: string;
  restartWindowOpensAt?: string;
  "restart-window-opens-at"?: string;
  restartWindowClosesAt?: string;
  "restart-window-closes-at"?: string;
  transactionId?: string;
  "transaction-id"?: string;
  approvalFile?: string;
  "approval-file"?: string;
  approvalToken?: string;
  "approval-token"?: string;
  liveCodexHome?: string;
  "live-codex-home"?: string;
  liveConfig?: string;
  "live-config"?: string;
  watcherReceipt?: string;
  "watcher-receipt"?: string;
}

export interface CodexSourceCommandDependencies {
  root(): string;
  probeBundledVersion(app?: string): string;
  fetchJson: GitHubJsonFetcher;
  resolveTag(tag: string): Promise<TagPeelIdentity>;
  fetchNpmVersions(): Promise<readonly string[] | null>;
  now(): string;
  print(value: string): void;
  production?: CodexSourceProductionDependencies;
  availableBytes?(path: string): bigint;
}

export interface CodexSourceProductionDependencies {
  stageManagedMcpPackages(options: StageCodexManagedMcpPackagesOptions): ManagedMcpStageEvidence;
  /** Optional only for legacy test adapters; the production adapter always supplies it. */
  prepareManagedMcpLifecycle?(input: PrepareManagedMcpLifecycleInput): ManagedMcpPreparedRuntimeEvidence;
  installIsolatedPlugins?(input: CodexSourcePluginInstallInput): readonly CodexSourceInstalledPluginEvidence[];
  createCanaryObservationAdapter?(input: ManagedMcpCanaryRunInput): ManagedMcpCanaryObservationAdapter;
  createBuildAdapter(input: ProductionCodexSourceBuildAdapterInput): ProductionCodexSourceBuildAdapter;
  prepareCandidate(
    input: PrepareCodexSourceCandidateInput,
    deps: CodexSourcePreparationDependencies,
  ): Promise<CodexSourcePreparationResult>;
  freezeCandidate(
    input: FreezeCodexSourceCandidateInput,
    deps: Pick<
      CodexSourcePreparationDependencies,
      "fetchJson" | "resolveTag" | "fetchNpmVersions" | "probeBundledVersion" | "now"
    >,
  ): Promise<CodexSourceFreezeResult>;
  assertFrontendControlParity(input: FrontendControlParityInput): void;
  transactionId(): string;
}

export interface FrontendControlParityInput {
  selectedApp: string;
  pristineSourceApp: string;
}

export interface CodexSourceResolutionResult {
  schemaVersion: 1;
  kind: "codex-source-resolution";
  channel: CodexSourceChannel;
  bundledVersion: string | null;
  checkpoint: CodexResolutionCheckpoint;
  npm: NpmAgreement;
}

export interface CodexSourceBuildEvidence {
  source: CodexSourceEvidence;
  dependencies: readonly LockedDependencyEvidence[];
  frontendControl: FrontendControlEvidence;
  controlBinary: ArtifactEvidence;
  candidateBinary: ArtifactEvidence;
  managedMcp?: ManagedMcpPreparedRuntimeEvidence;
  trustedCanaryRunner?: {
    sourcePath: string;
    sha256: string;
  };
  trustedCanaryAdapter?: {
    sourcePath: string;
    sha256: string;
  };
  rustLifecycleTests?: CodexRustLifecycleTestEvidence;
}

export interface CodexPreparedSourceCandidate {
  schemaVersion: 1;
  kind: "codex-source-candidate";
  transactionId: string;
  channel: CodexSourceChannel;
  bundledVersion: string | null;
  controlApp: string | null;
  sourceRoot: string;
  cycle: CodexResolutionCycleState;
  npm: NpmAgreement;
  evidence: CodexSourceBuildEvidence;
  createdAt: string;
  updatedAt: string;
}

export type CodexSourcePreparationResult =
  | { status: "prepared"; candidate: CodexPreparedSourceCandidate }
  | { status: "superseded"; cycle: CodexResolutionCycleState };

export type CodexSourceFreezeResult =
  | { status: "frozen"; candidate: CodexPreparedSourceCandidate; receipt: CodexDerivedReceipt }
  | { status: "superseded"; cycle: CodexResolutionCycleState };

export interface CodexSourcePreparationDependencies {
  fetchJson: GitHubJsonFetcher;
  resolveTag(tag: string): Promise<TagPeelIdentity>;
  fetchNpmVersions(): Promise<readonly string[] | null>;
  checkoutSource(input: {
    sourceRoot: string;
    tag: string;
    peeledCommit: string;
  }): Promise<string> | string;
  verifySourceCommit(sourceRoot: string): Promise<string> | string;
  buildSource(input: {
    sourceRoot: string;
    channel: CodexSourceChannel;
    version: string;
    tag: string;
    peeledCommit: string;
  }): Promise<CodexSourceBuildEvidence>;
  probeBundledVersion?(): string;
  now(): string;
}

export interface PrepareCodexSourceCandidateInput {
  channel?: CodexSourceChannel;
  bundledVersion?: string;
  controlApp?: string;
  sourceRoot: string;
  transactionId?: string;
  floors?: Partial<Record<CodexSourceChannel, ChannelPromotionFloor>>;
}

export interface FreezeCodexSourceCandidateInput {
  candidate: CodexPreparedSourceCandidate;
  restartWindow: RestartWindow;
  watcher: WatcherPromotionEvidence;
  receiptFile: string;
  floors?: Partial<Record<CodexSourceChannel, ChannelPromotionFloor>>;
}

export interface CodexSourceTransactionPaths {
  root: string;
  sourceRoot: string;
  candidateApp: string;
  candidateStateFile: string;
  canaryEvidenceFile: string;
  canaryHome: string;
  canaryRunnerEvidenceFile: string;
  receiptFile: string;
}

export interface CodexSourcePluginInstallInput {
  candidatePath: string;
  codexHome: string;
  marketplaceRoot: string;
  marketplaceName: string;
  plugins: readonly {
    artifactId: string;
    pluginId: string;
    version: string;
    sourcePath: string;
    sha256: string;
    entryCount: number;
  }[];
}

export interface CodexSourceInstalledPluginEvidence {
  artifactId: string;
  owner: string;
  pluginId: string;
  version: string;
  installedPath: string;
  sha256: string;
  entryCount: number;
}

export interface ProductionCodexSourceBuildAdapterInput {
  transactionRoot: string;
  transactionId: string;
  frontendSourceApp: string;
  finalUserRoot: string;
  patchSeries: readonly string[];
  dependencies: readonly LockedDependencyEvidence[];
  managedMcp?: ManagedMcpPreparedRuntimeEvidence;
}

export interface ValidatedBundledDerivedArtifact {
  binaryPath: string;
  version: string;
  fingerprint: string;
  receiptPath: string;
  transactionId: string;
}

export type ProductionCodexSourceBuildAdapter =
  Pick<CodexSourcePreparationDependencies, "checkoutSource" | "verifySourceCommit" | "buildSource"> & {
    paths: CodexSourceTransactionPaths;
  };

export interface CodexSourceBuildCommandResult {
  schemaVersion: 1;
  kind: "codex-source-build";
  status: "prepared" | "superseded";
  transactionId: string;
  channel: CodexSourceChannel;
  paths: CodexSourceTransactionPaths;
  managedMcp: ManagedMcpStageEvidence;
  managedMcpRuntime?: ManagedMcpPreparedRuntimeEvidence;
  receipt: CodexDerivedReceipt | null;
  liveMutation: false;
}

export interface CodexSourceCanaryPassResult {
  schemaVersion: 1;
  kind: "codex-source-canary-pass";
  transactionId: string;
  candidateStateFile: string;
  canaryEvidenceFile: string;
  version: string;
  liveMutation: false;
}

export interface CodexSourceFreezeCommandResult {
  schemaVersion: 1;
  kind: "codex-source-freeze";
  transactionId: string;
  receiptFile: string;
  receipt: CodexDerivedReceipt;
  liveMutation: false;
}

export type CodexSourceIsolatedCanaryEvidence = ManagedMcpCanaryEvidence;

/**
 * Select the last-known-good receipt for a failed source cycle.
 *
 * The default desktop-bundled lane remains pinned to the exact backend shipped
 * by that desktop build. Stable and edge cycles deliberately share the stable
 * fallback lane: an edge-derived receipt (or any prerelease disguised as a
 * stable-channel receipt) is never a recovery target.
 */
export function selectLastKnownGoodCodexSourceFallback(
  receipts: readonly unknown[],
  channel: CodexSourceChannel,
  installedBundledVersion?: string,
): CodexDerivedReceipt | null {
  const completed = receipts
    .filter(isCodexDerivedReceipt)
    .filter((receipt) =>
      receipt.phase === "completed"
      && receipt.supersededBy === null
      && receipt.error === null
    );

  if (channel === "bundled") {
    const version = requireExactVersion(installedBundledVersion);
    const eligible = completed
      .filter((receipt) => receipt.channel === "bundled" && receipt.version === version)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return eligible[0] ?? null;
  }

  const eligible = completed
    .filter((receipt) => {
      const parsed = parseSemver(receipt.version);
      return receipt.channel === "stable" && parsed !== null && parsed.prerelease.length === 0;
    })
    .sort((left, right) => {
      const precedence = compareSemverPrecedence(right.version, left.version);
      return precedence !== 0 ? precedence : Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  return eligible[0] ?? null;
}

/** Backward-compatible exact-bundled selector for callers that do not use optional channels. */
export function selectLastKnownGoodBundledFallback(
  receipts: readonly unknown[],
  installedBundledVersion: string,
): CodexDerivedReceipt | null {
  return selectLastKnownGoodCodexSourceFallback(receipts, "bundled", installedBundledVersion);
}

interface AdvisoryCacheFile {
  schemaVersion: 1;
  channel: CodexSourceChannel;
  bundledVersion: string | null;
  etag: string | null;
  lastKnownVersion: string | null;
  lastKnownTag: string | null;
  lastAttemptAt: string;
  nextAttemptAt: string;
}

export type DailyCodexSourceDetectionResult =
  | AdvisoryDetectionResult
  | { status: "throttled"; channel: CodexSourceChannel; nextAttemptAt: string };

export async function codexSource(
  rawAction: string,
  options: CodexSourceOptions = {},
  dependencies?: CodexSourceCommandDependencies,
): Promise<
  | CodexSourceResolutionResult
  | DailyCodexSourceDetectionResult
  | CodexDerivedReceipt
  | CodexSourceBuildCommandResult
  | CodexSourceCanaryPassResult
  | CodexSourceFreezeCommandResult
  | CodexSourceCutoverReceipt
  | null
> {
  const action = parseAction(rawAction);
  const deps = dependencies ?? defaultCommandDependencies();
  const root = join(deps.root(), "codex-source");

  let result:
    | CodexSourceResolutionResult
    | DailyCodexSourceDetectionResult
    | CodexDerivedReceipt
    | CodexSourceBuildCommandResult
    | CodexSourceCanaryPassResult
    | CodexSourceFreezeCommandResult
    | CodexSourceCutoverReceipt
    | null;
  if (action === "build") {
    result = await buildCodexSourceCandidate(options, deps);
  } else if (action === "canary-pass") {
    result = await recordCodexSourceCanaryPass(options, deps);
  } else if (action === "freeze") {
    result = await freezePreparedCodexSourceCandidate(options, deps);
  } else if (action === "cutover" || action === "rollback") {
    const transactionId = requireTransactionId(optionValue(options, "transactionId", "transaction-id"));
    const paths = codexSourceTransactionPaths(requireInternalAbsolutePath(deps.root(), "Codex source transaction root", false), transactionId);
    const cutoverInput = {
      transactionId,
      sourceReceiptFile: paths.receiptFile,
      candidateApp: paths.candidateApp,
      liveApp: requireInternalAbsolutePath(options.app, "live ChatGPT app", true),
      liveCodexHome: requireInternalAbsolutePath(optionValue(options, "liveCodexHome", "live-codex-home"), "live CODEX_HOME", true),
      liveConfig: requireInternalAbsoluteFile(optionValue(options, "liveConfig", "live-config"), "live Codex config"),
      watcherReceipt: requireInternalAbsolutePath(optionValue(options, "watcherReceipt", "watcher-receipt"), "watcher promotion receipt", false),
      transactionRoot: join(paths.root, "cutover"),
      approvalFile: requireInternalAbsoluteFile(optionValue(options, "approvalFile", "approval-file"), "Codex restart approval"),
      approvalToken: requireNonEmptyOption(
        optionValue(options, "approvalToken", "approval-token") ?? process.env.TWEAKER_CODEX_RESTART_APPROVAL_TOKEN,
        "TWEAKER_CODEX_RESTART_APPROVAL_TOKEN",
      ),
      now: deps.now,
    };
    result = action === "cutover"
      ? executeCodexSourceCutover(cutoverInput)
      : rollbackCodexSourceCutover(cutoverInput);
  } else {
    const channel = parseChannel(options.channel);
    const bundledVersion = channel === "bundled"
      ? deps.probeBundledVersion(options.app ?? STOCK_CHATGPT_APP)
      : undefined;
    if (action === "detect") {
    result = await runDailyCodexSourceDetection({
      channel,
      bundledVersion,
      cacheFile: join(root, `advisory-${channel}.json`),
      force: options.force === true,
      fetchJson: deps.fetchJson,
      now: deps.now,
    });
    } else if (action === "resolve") {
      result = await resolveCodexSourceControl({
        channel,
        bundledVersion,
        checkpoint: "R1",
        fetchJson: deps.fetchJson,
        resolveTag: deps.resolveTag,
        fetchNpmVersions: deps.fetchNpmVersions,
        now: deps.now,
      });
    } else {
      const receipt = readCodexDerivedReceipt(join(root, `current-${channel}.json`));
      result = receipt?.schemaVersion === CODEX_DERIVED_RECEIPT_SCHEMA_VERSION ? receipt : null;
    }
  }
  printCommandResult(result, options, deps);
  return result;
}

/**
 * Resolve R1/R2, build, stage, and sign a disposable source-derived desktop
 * candidate. R3 is intentionally deferred until after an isolated canary and
 * immediately before promotion; this action emits no consumable receipt.
 */
export async function buildCodexSourceCandidate(
  options: CodexSourceOptions,
  deps: CodexSourceCommandDependencies,
): Promise<CodexSourceBuildCommandResult> {
  const production = deps.production ?? defaultProductionDependencies();
  const channel = parseChannel(options.channel);
  const transactionId = requireTransactionId(optionValue(options, "transactionId", "transaction-id") ?? production.transactionId());
  const transactionRoot = requireInternalAbsolutePath(deps.root(), "Codex source transaction root", false);
  const paths = codexSourceTransactionPaths(transactionRoot, transactionId);
  const frontendSourceApp = requireInternalAbsolutePath(
    optionValue(options, "frontendSourceApp", "frontend-source-app"),
    "pristine frontend source app",
    true,
  );
  const selectedApp = requireInternalAbsolutePath(options.app ?? STOCK_CHATGPT_APP, "selected installed app", false);
  const patchSeries = parsePatchSeries(optionValue(options, "patchSeries", "patch-series")).map((path) =>
    requireInternalAbsoluteFile(path, "Codex source patch")
  );
  const chromePluginRoot = requireInternalAbsolutePath(
    optionValue(options, "chromePluginRoot", "chrome-plugin-root"),
    "Chrome plugin root",
    true,
  );
  const playwrightPluginRoot = requireInternalAbsolutePath(
    optionValue(options, "playwrightPluginRoot", "playwright-plugin-root"),
    "Playwright plugin root",
    true,
  );
  const bundledVersion = channel === "bundled"
    ? deps.probeBundledVersion(options.app ?? STOCK_CHATGPT_APP)
    : undefined;
  const floors = authoritativeSameChannelFloor(transactionRoot, channel);
  production.assertFrontendControlParity({ selectedApp, pristineSourceApp: frontendSourceApp });
  assertMinimumBuildFreeSpace(
    transactionRoot,
    (deps.availableBytes ?? filesystemAvailableBytes)(transactionRoot),
  );

  // Package staging precedes source preparation so the candidate state (and a
  // future post-canary receipt) commits to the exact reviewed MCP artifacts.
  const managedMcp = production.stageManagedMcpPackages({
    chromePluginRoot,
    playwrightPluginRoot,
    managedMcpRoot: join(paths.root, "prepared", "managed-package-staging"),
    now: deps.now,
  });
  const managedMcpRuntime = production.prepareManagedMcpLifecycle
    ? production.prepareManagedMcpLifecycle({
        manifestFile: requireInternalAbsoluteFile(
          optionValue(options, "fleetManifest", "fleet-manifest"),
          "managed MCP fleet manifest",
        ),
        runtimeRoot: join(paths.root, "prepared", "managed-runtime"),
        now: deps.now,
      })
    : undefined;
  if (managedMcpRuntime) assertManagedMcpPreparedRuntimeEvidence(managedMcpRuntime);
  const dependencies = lockedDependenciesFromManagedMcp(managedMcp);
  const adapter = production.createBuildAdapter({
    transactionRoot,
    transactionId,
    frontendSourceApp,
    finalUserRoot: transactionRoot,
    patchSeries,
    dependencies,
    ...(managedMcpRuntime ? { managedMcp: managedMcpRuntime } : {}),
  });
  if (JSON.stringify(adapter.paths) !== JSON.stringify(paths)) {
    throw new Error("Production Codex source adapter returned unexpected transaction paths");
  }
  const resolutionDeps: CodexSourcePreparationDependencies = {
    fetchJson: deps.fetchJson,
    resolveTag: deps.resolveTag,
    fetchNpmVersions: deps.fetchNpmVersions,
    now: deps.now,
    checkoutSource: adapter.checkoutSource,
    verifySourceCommit: adapter.verifySourceCommit,
    buildSource: adapter.buildSource,
    probeBundledVersion: () => deps.probeBundledVersion(selectedApp),
  };
  const prepared = await production.prepareCandidate({
    channel,
    bundledVersion,
    controlApp: channel === "bundled" ? selectedApp : undefined,
    sourceRoot: paths.sourceRoot,
    transactionId,
    floors,
  }, resolutionDeps);
  if (prepared.status === "superseded") {
    atomicJsonWrite(paths.candidateStateFile, {
      schemaVersion: 1,
      kind: "codex-source-candidate-state",
      transactionId,
      status: "superseded",
      cycle: prepared.cycle,
      updatedAt: deps.now(),
    });
    return {
      schemaVersion: 1,
      kind: "codex-source-build",
      status: "superseded",
      transactionId,
      channel,
      paths,
      managedMcp,
      ...(managedMcpRuntime ? { managedMcpRuntime } : {}),
      receipt: null,
      liveMutation: false,
    };
  }
  const trustedRunnerSourcePath = trustedManagedMcpCanaryRunnerSourcePath();
  const trustedAdapterSourcePath = trustedManagedMcpAppServerAdapterSourcePath();
  const boundCandidate: CodexPreparedSourceCandidate = {
    ...prepared.candidate,
    evidence: {
      ...prepared.candidate.evidence,
      trustedCanaryRunner: {
        sourcePath: trustedRunnerSourcePath,
        sha256: sha256TrustedManagedMcpCanaryRunnerSource(trustedRunnerSourcePath),
      },
      trustedCanaryAdapter: {
        sourcePath: trustedAdapterSourcePath,
        sha256: sha256TrustedManagedMcpAppServerAdapterSource(trustedAdapterSourcePath),
      },
    },
  };
  atomicJsonWrite(paths.candidateStateFile, boundCandidate);
  return {
    schemaVersion: 1,
    kind: "codex-source-build",
    status: "prepared",
    transactionId,
    channel,
    paths,
    managedMcp,
    ...(managedMcpRuntime ? { managedMcpRuntime } : {}),
    receipt: null,
    liveMutation: false,
  };
}

/** Prepare an isolated CODEX_HOME and accept only evidence emitted by an attested runner. */
async function recordCodexSourceCanaryPass(
  options: CodexSourceOptions,
  deps: CodexSourceCommandDependencies,
): Promise<CodexSourceCanaryPassResult> {
  const production = deps.production ?? defaultProductionDependencies();
  const transactionId = requireTransactionId(optionValue(options, "transactionId", "transaction-id"));
  const root = requireInternalAbsolutePath(deps.root(), "Codex source transaction root", false);
  const paths = codexSourceTransactionPaths(root, transactionId);
  const candidate = readPreparedSourceCandidate(paths.candidateStateFile, transactionId);
  const candidatePath = requireInternalAbsoluteFile(
    join(paths.candidateApp, "Contents", "Resources", "codex"),
    "source-derived canary candidate",
  );
  const candidateSha256 = sha256File(candidatePath);
  const candidateStateSha256 = candidate.evidence.candidateBinary.digests.find((digest) =>
    digest.algorithm === "sha256" && digest.scope === "derived candidate binary"
  )?.value.toLowerCase();
  if (!candidateStateSha256 || candidateStateSha256 !== candidateSha256) {
    throw new Error("Source-derived canary candidate does not match the prepared candidate state");
  }
  assertRustLifecycleTestEvidence(candidate.evidence.rustLifecycleTests, candidate, candidateSha256);
  const managedMcp = candidate.evidence.managedMcp;
  if (!managedMcp) throw new Error("Prepared candidate lacks complete managed MCP fleet evidence");
  assertManagedMcpPreparedRuntimeEvidence(managedMcp);
  rmSync(paths.canaryHome, { recursive: true, force: true });
  mkdirSync(paths.canaryHome, { recursive: true });
  const configFile = join(paths.canaryHome, "config.toml");
  const configBytes = Buffer.from("[features]\nplugins = true\nmcp_on_demand = true\n");
  atomicTextWrite(configFile, configBytes);
  const marketplaceName = "codex-on-demand-canary";
  const marketplaceRoot = join(paths.canaryHome, "marketplace", marketplaceName);
  const pluginInputs = prepareIsolatedPluginMarketplace(managedMcp, marketplaceRoot, marketplaceName);
  const installPlugins = production.installIsolatedPlugins ?? installPluginsWithCandidateManager;
  const installedPlugins = installPlugins({
    candidatePath,
    codexHome: paths.canaryHome,
    marketplaceRoot,
    marketplaceName,
    plugins: pluginInputs,
  });
  assertInstalledPluginFleet(pluginInputs, installedPlugins, paths.canaryHome, marketplaceName);
  const pluginOverrides = Object.fromEntries(installedPlugins.map((plugin) => [plugin.artifactId, plugin.installedPath]));
  const installedRuntime = installManagedMcpPreparedRuntime(
    managedMcp,
    join(paths.canaryHome, "managed-runtime"),
    { now: deps.now, artifactDestinationOverrides: pluginOverrides },
  );
  reconcileIsolatedGlobalMcpConfig(configFile, installedRuntime.configReconciliation);
  const finalConfigSha256 = sha256File(configFile);
  const trustedRunner = candidate.evidence.trustedCanaryRunner;
  const trustedAdapter = candidate.evidence.trustedCanaryAdapter;
  if (!trustedRunner
    || trustedRunner.sourcePath !== trustedManagedMcpCanaryRunnerSourcePath()
    || trustedRunner.sha256 !== sha256TrustedManagedMcpCanaryRunnerSource(trustedRunner.sourcePath)) {
    throw new Error("Prepared candidate is not bound to the current repository-owned canary runner source");
  }
  if (!trustedAdapter
    || trustedAdapter.sourcePath !== trustedManagedMcpAppServerAdapterSourcePath()
    || trustedAdapter.sha256 !== sha256TrustedManagedMcpAppServerAdapterSource(trustedAdapter.sourcePath)) {
    throw new Error("Prepared candidate is not bound to the repository-owned app-server canary adapter source");
  }
  const expectedRoutes = managedMcpCanaryExpectedRoutes(installedRuntime);
  const runInput: ManagedMcpCanaryRunInput = {
    transactionId,
    version: candidate.evidence.candidateBinary.version,
    candidatePath,
    candidateSha256,
    codexHome: paths.canaryHome,
    configPath: configFile,
    configSha256: finalConfigSha256,
    managedRuntime: installedRuntime,
    pluginBundles: installedPlugins.map(({ owner, installedPath, sha256 }) => ({ owner, installedPath, sha256 })),
    expectedRoutes,
    trustedRunnerExpectedSha256: trustedRunner.sha256,
    trustedAdapterExpectedSha256: trustedAdapter.sha256,
    rustLifecycleTests: candidate.evidence.rustLifecycleTests!,
  };
  const createAdapter = production.createCanaryObservationAdapter;
  if (!createAdapter) {
    throw new Error("Repository-owned managed MCP canary observation adapter is unavailable; live promotion remains disabled");
  }
  rmSync(paths.canaryRunnerEvidenceFile, { force: true });
  const produced = await runManagedMcpCanary(runInput, createAdapter(runInput));
  assertManagedMcpCanaryEvidence(produced, runInput);
  writeManagedMcpCanaryEvidence(paths.canaryRunnerEvidenceFile, produced);
  const evidence = requireInternalAbsoluteFile(paths.canaryRunnerEvidenceFile, "isolated canary runner evidence");
  const canary = readStrictIsolatedCanaryEvidence(evidence);
  assertManagedMcpCanaryEvidence(canary, runInput);
  const installedOverlay = readAndVerifyManagedMcpLifecycleOverlay(installedRuntime.overlayFile);
  if (
    canary.transactionId !== transactionId
    || canary.version !== candidate.evidence.candidateBinary.version
    || canary.candidate.path !== candidatePath
    || canary.candidate.sha256 !== candidateSha256
    || canary.isolatedHome.root !== paths.canaryHome
    || canary.isolatedHome.configPath !== configFile
    || canary.isolatedHome.configSha256 !== finalConfigSha256
    || sha256File(configFile) !== canary.isolatedHome.configSha256
    || canary.managedMcp.runtimeRoot !== installedRuntime.runtimeRoot
    || canary.managedMcp.managedPackageRoot !== installedRuntime.managedPackageRoot
    || canary.managedMcp.runtimeTreeSha256 !== installedRuntime.runtimeTreeSha256
    || canary.managedMcp.overlayPath !== installedRuntime.overlayFile
    || canary.managedMcp.overlaySha256 !== installedRuntime.overlaySha256
    || canary.managedMcp.fleetFingerprint !== installedRuntime.fleetFingerprint
    || installedOverlay.fleetFingerprint !== installedRuntime.fleetFingerprint
    || JSON.stringify(canary.managedMcp.requiredCoverage) !== JSON.stringify(installedRuntime.requiredCoverage)
    || canary.managedMcp.mcpOnDemandEnabled !== true
    || JSON.stringify(canary.pluginBundles.map(({ routeOwnerProven: _routeOwnerProven, ...item }) => item))
      !== JSON.stringify(installedPlugins.map(({ artifactId: _artifactId, pluginId: _pluginId, version: _version, entryCount: _entryCount, ...item }) => item))
    || canary.pluginBundles.some((plugin) => plugin.routeOwnerProven !== true)
    || canary.trustedRunner.identity !== trustedRunner.sourcePath
    || canary.trustedRunner.attestationSha256 !== trustedRunner.sha256
  ) {
    throw new Error("Isolated canary evidence is not bound to the prepared candidate receipt");
  }
  const now = deps.now();
  atomicJsonWrite(paths.canaryEvidenceFile, {
    schemaVersion: 1,
    kind: "codex-source-canary-evidence",
    transactionId,
    sourceFile: evidence,
    sourceSha256: sha256File(evidence),
    version: canary.version,
    candidatePath,
    candidateSha256,
    isolatedHome: canary.isolatedHome,
    lifecycle: canary.lifecycle,
    managedMcp: canary.managedMcp,
    installedManagedMcp: installedRuntime,
    pluginBundles: canary.pluginBundles,
    trustedRunner: canary.trustedRunner,
    trustedObservationAdapter: canary.trustedObservationAdapter,
    canaryStartedAt: canary.startedAt,
    canaryCompletedAt: canary.completedAt,
    recordedAt: now,
  });
  return {
    schemaVersion: 1,
    kind: "codex-source-canary-pass",
    transactionId,
    candidateStateFile: paths.candidateStateFile,
    canaryEvidenceFile: paths.canaryEvidenceFile,
    version: canary.version,
    liveMutation: false,
  };
}

/** Run fresh R3 inside the approved window and emit a canary-passed receipt for promotion handoff. */
async function freezePreparedCodexSourceCandidate(
  options: CodexSourceOptions,
  deps: CodexSourceCommandDependencies,
): Promise<CodexSourceFreezeCommandResult> {
  const production = deps.production ?? defaultProductionDependencies();
  const transactionId = requireTransactionId(optionValue(options, "transactionId", "transaction-id"));
  const root = requireInternalAbsolutePath(deps.root(), "Codex source transaction root", false);
  const paths = codexSourceTransactionPaths(root, transactionId);
  const candidate = readPreparedSourceCandidate(paths.candidateStateFile, transactionId);
  const canary = assertValidatedCanarySidecar(paths.canaryEvidenceFile, candidate, paths);
  const restartWindow = parseRestartWindow(
    optionValue(options, "restartWindowOpensAt", "restart-window-opens-at"),
    optionValue(options, "restartWindowClosesAt", "restart-window-closes-at"),
  );
  const floors = authoritativeSameChannelFloor(root, candidate.channel);
  const frozen = await production.freezeCandidate({
    candidate,
    restartWindow,
    watcher: untouchedWatcherEvidence(),
    receiptFile: paths.receiptFile,
    floors,
  }, {
    fetchJson: deps.fetchJson,
    resolveTag: deps.resolveTag,
    fetchNpmVersions: deps.fetchNpmVersions,
    probeBundledVersion: candidate.channel === "bundled"
      ? () => deps.probeBundledVersion(candidate.controlApp ?? STOCK_CHATGPT_APP)
      : undefined,
    now: deps.now,
  });
  if (frozen.status === "superseded") {
    atomicJsonWrite(paths.candidateStateFile, {
      schemaVersion: 1,
      kind: "codex-source-candidate-state",
      transactionId,
      status: "superseded",
      cycle: frozen.cycle,
      updatedAt: deps.now(),
    });
    throw new Error("Codex source candidate was superseded at R3; build a new candidate");
  }
  const receipt: CodexDerivedReceipt = {
    ...frozen.receipt,
    phase: "canary-passed",
    canary,
    updatedAt: deps.now(),
  };
  writeCodexDerivedReceipt(paths.receiptFile, receipt);
  atomicJsonWrite(paths.candidateStateFile, frozen.candidate);
  return {
    schemaVersion: 1,
    kind: "codex-source-freeze",
    transactionId,
    receiptFile: paths.receiptFile,
    receipt,
    liveMutation: false,
  };
}

export async function resolveCodexSourceControl(input: {
  channel?: CodexSourceChannel;
  bundledVersion?: string;
  checkpoint: CodexResolutionCheckpoint["name"];
  fetchJson: GitHubJsonFetcher;
  resolveTag(tag: string): Promise<TagPeelIdentity>;
  fetchNpmVersions(): Promise<readonly string[] | null>;
  now(): string;
}): Promise<CodexSourceResolutionResult> {
  const channel = input.channel ?? "bundled";
  const resolution = await resolveCodexSourceRelease({
    channel,
    ...(channel === "bundled" ? { bundledVersion: requireExactVersion(input.bundledVersion) } : {}),
    fetchJson: input.fetchJson,
    now: input.now,
  });
  const peeled = await input.resolveTag(resolution.resolvedTag);
  const npm = evaluateNpmAgreement({
    channel,
    githubVersion: resolution.normalizedVersion,
    npmVersions: await input.fetchNpmVersions(),
  });
  // Bundled is aligned to the signed installed frontend and exact GitHub tag.
  // npm is observation-only there; standalone stable/edge fail closed if npm leads.
  if (channel !== "bundled") assertNpmDoesNotLead(npm);
  return {
    schemaVersion: 1,
    kind: "codex-source-resolution",
    channel,
    bundledVersion: channel === "bundled" ? resolution.normalizedVersion : null,
    checkpoint: checkpointFromResolution(input.checkpoint, resolution, peeled),
    npm,
  };
}

export async function prepareCodexSourceCandidate(
  input: PrepareCodexSourceCandidateInput,
  deps: CodexSourcePreparationDependencies,
): Promise<CodexSourcePreparationResult> {
  const channel = input.channel ?? "bundled";
  const probeBundled = (): string | undefined => channel === "bundled"
    ? requireExactVersion(deps.probeBundledVersion?.() ?? input.bundledVersion)
    : undefined;
  const r1BundledVersion = probeBundled();
  const r1 = await resolveCodexSourceControl({
    channel,
    bundledVersion: r1BundledVersion,
    checkpoint: "R1",
    fetchJson: deps.fetchJson,
    resolveTag: deps.resolveTag,
    fetchNpmVersions: deps.fetchNpmVersions,
    now: deps.now,
  });
  assertChannelPromotionAllowed({
    channel,
    candidateVersion: r1.checkpoint.normalizedVersion,
    candidateCommit: r1.checkpoint.peeledCommit,
    floors: input.floors ?? {},
  });
  let cycle = createCodexResolutionCycle(r1.checkpoint);
  const checkedOut = await deps.checkoutSource({
    sourceRoot: input.sourceRoot,
    tag: r1.checkpoint.resolvedTag,
    peeledCommit: r1.checkpoint.peeledCommit,
  });
  assertExactCommit("checked-out source", checkedOut, r1.checkpoint.peeledCommit);

  const r2BundledVersion = probeBundled();
  const r2 = await resolveCodexSourceControl({
    channel,
    bundledVersion: r2BundledVersion,
    checkpoint: "R2",
    fetchJson: deps.fetchJson,
    resolveTag: deps.resolveTag,
    fetchNpmVersions: deps.fetchNpmVersions,
    now: deps.now,
  });
  cycle = recordCodexResolutionCheckpoint(cycle, r2.checkpoint);
  if (cycle.status === "superseded") return { status: "superseded", cycle };
  assertChannelPromotionAllowed({
    channel,
    candidateVersion: r2.checkpoint.normalizedVersion,
    candidateCommit: r2.checkpoint.peeledCommit,
    floors: input.floors ?? {},
  });
  assertExactCommit("pre-build source", await deps.verifySourceCommit(input.sourceRoot), r2.checkpoint.peeledCommit);
  const evidence = await deps.buildSource({
    sourceRoot: input.sourceRoot,
    channel,
    version: r2.checkpoint.normalizedVersion,
    tag: r2.checkpoint.resolvedTag,
    peeledCommit: r2.checkpoint.peeledCommit,
  });
  assertExactCommit("post-build source", await deps.verifySourceCommit(input.sourceRoot), r2.checkpoint.peeledCommit);
  assertBuildEvidence(evidence, r2.checkpoint);
  const now = deps.now();
  return {
    status: "prepared",
    candidate: {
      schemaVersion: 1,
      kind: "codex-source-candidate",
      transactionId: input.transactionId ?? randomUUID(),
      channel,
      bundledVersion: r2BundledVersion ?? null,
      controlApp: channel === "bundled" ? input.controlApp ?? null : null,
      sourceRoot: input.sourceRoot,
      cycle,
      npm: r2.npm,
      evidence,
      createdAt: now,
      updatedAt: now,
    },
  };
}

export async function freezeCodexSourceCandidate(
    input: FreezeCodexSourceCandidateInput,
    deps: Pick<
      CodexSourcePreparationDependencies,
      "fetchJson" | "resolveTag" | "fetchNpmVersions" | "probeBundledVersion" | "now"
    >,
): Promise<CodexSourceFreezeResult> {
  assertInternalStoragePath(input.receiptFile, "Codex derived receipt");
  const r3 = await resolveCodexSourceControl({
    channel: input.candidate.channel,
    ...(input.candidate.channel === "bundled"
      ? {
          bundledVersion: requireExactVersion(
            deps.probeBundledVersion?.() ?? input.candidate.bundledVersion ?? undefined,
          ),
        }
      : {}),
    checkpoint: "R3",
    fetchJson: deps.fetchJson,
    resolveTag: deps.resolveTag,
    fetchNpmVersions: deps.fetchNpmVersions,
    now: deps.now,
  });
  assertChannelPromotionAllowed({
    channel: input.candidate.channel,
    candidateVersion: r3.checkpoint.normalizedVersion,
    candidateCommit: r3.checkpoint.peeledCommit,
    floors: input.floors ?? {},
  });
  const now = deps.now();
  const cycle = recordCodexResolutionCheckpoint(input.candidate.cycle, r3.checkpoint, {
    restartWindow: input.restartWindow,
    now,
  });
  if (cycle.status === "superseded") return { status: "superseded", cycle };
  const candidate = { ...input.candidate, cycle, npm: r3.npm, updatedAt: now };
  const evidence = candidate.evidence;
  const receipt: CodexDerivedReceipt = {
    schemaVersion: CODEX_DERIVED_RECEIPT_SCHEMA_VERSION,
    kind: "codex-derived",
    transactionId: candidate.transactionId,
    phase: "prepared",
    channel: candidate.channel,
    version: r3.checkpoint.normalizedVersion,
    label: codexDerivedLabel(candidate.channel, r3.checkpoint.normalizedVersion),
    resolution: resolutionEvidenceFromCycle(cycle, CODEX_GITHUB_API_VERSION),
    source: evidence.source,
    dependencies: evidence.dependencies,
    frontendControl: evidence.frontendControl,
    controlBinary: evidence.controlBinary,
    candidateBinary: evidence.candidateBinary,
    ...(evidence.managedMcp ? { managedMcp: evidence.managedMcp } : {}),
    ...(evidence.trustedCanaryRunner ? { trustedCanaryRunner: evidence.trustedCanaryRunner } : {}),
    ...(evidence.trustedCanaryAdapter ? { trustedCanaryAdapter: evidence.trustedCanaryAdapter } : {}),
    ...(evidence.rustLifecycleTests ? { rustLifecycleTests: evidence.rustLifecycleTests } : {}),
    watcher: input.watcher,
    supersedes: null,
    supersededBy: null,
    error: null,
    createdAt: candidate.createdAt,
    updatedAt: now,
    promotedAt: null,
    soakCompletedAt: null,
    rolledBackAt: null,
  };
  writeCodexDerivedReceipt(input.receiptFile, receipt);
  return { status: "frozen", candidate, receipt };
}

export async function runDailyCodexSourceDetection(input: {
  channel?: CodexSourceChannel;
  bundledVersion?: string;
  cacheFile: string;
  force?: boolean;
  fetchJson: GitHubJsonFetcher;
  now(): string;
}): Promise<DailyCodexSourceDetectionResult> {
  assertInternalStoragePath(input.cacheFile, "Codex advisory cache");
  const channel = input.channel ?? "bundled";
  const bundledVersion = channel === "bundled" ? requireExactVersion(input.bundledVersion) : null;
  const cache = readAdvisoryCache(input.cacheFile, channel, bundledVersion);
  const now = input.now();
  if (!input.force && cache && Date.parse(now) < Date.parse(cache.nextAttemptAt)) {
    return { status: "throttled", channel, nextAttemptAt: cache.nextAttemptAt };
  }
  const detected = await detectCodexReleaseAdvisory({
    channel,
    ...(bundledVersion ? { bundledVersion } : {}),
    fetchJson: input.fetchJson,
    cache: cache ? {
      etag: cache.etag,
      lastKnownVersion: cache.lastKnownVersion,
      lastKnownTag: cache.lastKnownTag,
    } : undefined,
    now: input.now,
  });
  const observed = detected.status === "observed" ? detected.selection : null;
  const next: AdvisoryCacheFile = {
    schemaVersion: 1,
    channel,
    bundledVersion,
    etag: detected.etag ?? cache?.etag ?? null,
    lastKnownVersion: observed?.version ?? cache?.lastKnownVersion ?? null,
    lastKnownTag: observed?.tag ?? cache?.lastKnownTag ?? null,
    lastAttemptAt: now,
    nextAttemptAt: new Date(Date.parse(now) + DAILY_CHECK_MS).toISOString(),
  };
  atomicJsonWrite(input.cacheFile, next);
  return detected;
}

export function createGitHubJsonFetcher(fetchImpl: typeof fetch = fetch): GitHubJsonFetcher {
  return async <T>(request: GitHubJsonRequest): Promise<GitHubJsonResponse<T>> => {
    const response = await fetchImpl(request.url, {
      headers: {
        ...request.headers,
        "User-Agent": "tweakers-codex-source",
      },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let data: T | undefined;
    if (bytes.length > 0) data = JSON.parse(new TextDecoder().decode(bytes)) as T;
    return {
      status: response.status,
      ...(data === undefined ? {} : { data }),
      etag: response.headers.get("etag"),
      bodySha256: createHash("sha256").update(bytes).digest("hex"),
      nextUrl: parseGitHubNextUrl(response.headers.get("link")),
      rateLimited: (response.status === 403 || response.status === 429)
        && response.headers.get("x-ratelimit-remaining") === "0",
    };
  };
}

export function createGitHubTagResolver(
  fetchJson: GitHubJsonFetcher,
): (tag: string) => Promise<TagPeelIdentity> {
  return async (tag) => {
    if (!parseCodexReleaseTag(tag)) throw new Error(`Invalid Codex release tag: ${tag}`);
    const refUrl = `${GITHUB_API_ORIGIN}/repos/${CODEX_RELEASE_REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`;
    const refResponse = await fetchJson({ url: refUrl, headers: githubHeaders() });
    const ref = gitIdentityFromRefResponse(refResponse, refUrl);
    return peelCodexTag({
      tag,
      ref,
      fetchTagObject: async (sha) => {
        const url = `${GITHUB_API_ORIGIN}/repos/${CODEX_RELEASE_REPOSITORY}/git/tags/${sha}`;
        const response = await fetchJson({ url, headers: githubHeaders() });
        return gitIdentityFromTagResponse(response, url);
      },
    });
  };
}

export async function fetchNpmCodexVersions(fetchImpl: typeof fetch = fetch): Promise<readonly string[] | null> {
  try {
    const response = await fetchImpl(NPM_CODEX_ENDPOINT, {
      headers: { Accept: "application/json", "User-Agent": "tweakers-codex-source" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const value = await response.json() as { versions?: unknown };
    if (!value || typeof value !== "object" || !value.versions || typeof value.versions !== "object") return null;
    return Object.keys(value.versions).filter((version) => parseSemver(version) !== null);
  } catch {
    return null;
  }
}

/** Create a detached official source checkout whose HEAD is the peeled tag commit. */
export function checkoutOfficialCodexSource(input: {
  sourceRoot: string;
  tag: string;
  peeledCommit: string;
  git?: (args: readonly string[], cwd?: string) => string;
}): string {
  assertInternalStoragePath(input.sourceRoot, "Codex source checkout");
  if (!parseCodexReleaseTag(input.tag) || !validCommit(input.peeledCommit)) {
    throw new Error("Invalid Codex source checkout identity");
  }
  if (existsSync(input.sourceRoot)) throw new Error(`Codex source checkout path already exists: ${input.sourceRoot}`);
  mkdirSync(dirname(input.sourceRoot), { recursive: true });
  mkdirSync(input.sourceRoot, { mode: 0o700 });
  const git = input.git ?? runGit;
  git(["init", "--quiet"], input.sourceRoot);
  git(["remote", "add", "origin", CODEX_GIT_URL], input.sourceRoot);
  git(["fetch", "--depth=1", "origin", `refs/tags/${input.tag}:refs/tags/${input.tag}`], input.sourceRoot);
  git(["checkout", "--quiet", "--detach", input.peeledCommit], input.sourceRoot);
  const actual = git(["rev-parse", "HEAD"], input.sourceRoot).trim();
  assertExactCommit("official source checkout", actual, input.peeledCommit);
  return actual;
}

export function verifyOfficialCodexSourceCommit(sourceRoot: string): string {
  return runGit(["rev-parse", "HEAD"], sourceRoot).trim();
}

export function codexSourceTransactionPaths(root: string, transactionId: string): CodexSourceTransactionPaths {
  assertInternalStoragePath(root, "Codex source transaction root");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(transactionId)) {
    throw new Error("Codex source transaction ID is invalid");
  }
  const transactionRoot = join(root, "codex-source", "transactions", transactionId);
  return {
    root: transactionRoot,
    sourceRoot: join(transactionRoot, "source"),
    candidateApp: join(transactionRoot, "candidate", "ChatGPT.app"),
    candidateStateFile: join(transactionRoot, "candidate.json"),
    canaryEvidenceFile: join(transactionRoot, "canary-evidence.json"),
    canaryHome: join(transactionRoot, "canary-home"),
    canaryRunnerEvidenceFile: join(transactionRoot, "canary-home", "runner-evidence.json"),
    receiptFile: join(root, "codex-source", "receipts", `${transactionId}.json`),
  };
}

/**
 * Prove that the explicit pristine source is the exact frontend/backend control
 * selected for this build. The selected live outer bundle may be locally
 * signed; only the pristine source must retain OpenAI's Developer ID trust.
 */
export function assertFrontendControlParity(input: FrontendControlParityInput): void {
  if (process.platform !== "darwin") throw new Error("Codex desktop source builds require macOS");
  const selectedPath = requireInternalAbsolutePath(input.selectedApp, "selected installed app", true);
  const pristinePath = requireInternalAbsolutePath(input.pristineSourceApp, "pristine frontend source app", true);
  const selected = locateCodexAtExactPath(selectedPath);
  const pristine = locateCodexAtExactPath(pristinePath);
  const verified = verifySignature(pristinePath);
  const identity = signatureInfo(pristinePath);
  if (
    !verified.ok
    || identity.adHoc
    || identity.teamIdentifier !== "2DC432GLL2"
    || !identity.authority.some((authority) => /^Developer ID Application: OpenAI\b/.test(authority))
  ) {
    throw new Error("Pristine frontend source is not a strict OpenAI Developer ID app");
  }
  const selectedPlist = selected.metaPath ? readPlist(selected.metaPath) : {};
  const pristinePlist = pristine.metaPath ? readPlist(pristine.metaPath) : {};
  const parity = ["CFBundleShortVersionString", "CFBundleVersion", "CFBundleIdentifier"] as const;
  for (const key of parity) {
    const selectedValue = requiredPlistString(selectedPlist, key);
    const pristineValue = requiredPlistString(pristinePlist, key);
    if (selectedValue !== pristineValue) {
      throw new Error(`Pristine frontend source is stale: ${key} differs from the selected installed control`);
    }
  }
  const selectedBackend = exactExistingFile(join(selected.resourcesDir, "codex"), "selected installed backend");
  const pristineBackend = exactExistingFile(join(pristine.resourcesDir, "codex"), "pristine frontend backend");
  const selectedVersion = probeCodexBinaryVersion(selectedBackend);
  const pristineVersion = probeCodexBinaryVersion(pristineBackend);
  if (selectedVersion !== pristineVersion || sha256File(selectedBackend) !== sha256File(pristineBackend)) {
    throw new Error("Pristine frontend embedded backend does not match the selected installed backend control");
  }
}

/**
 * Production build/stage/sign adapter. It applies a reviewed patch artifact to
 * the exact detached GitHub commit, builds `codex-cli` with Cargo.lock, embeds
 * that binary in a disposable patched desktop candidate, then signs and
 * verifies the whole candidate. It never mutates or opens the source/live app.
 */
export function createProductionCodexSourceBuildAdapter(
  input: ProductionCodexSourceBuildAdapterInput,
): ProductionCodexSourceBuildAdapter {
  const paths = codexSourceTransactionPaths(input.transactionRoot, input.transactionId);
  if (input.patchSeries.length === 0) throw new Error("Codex source build requires a reviewed patch series artifact");
  const patchFiles = input.patchSeries.map((file) => exactExistingFile(file, "patch series"));
  const frontendSourceApp = exactExistingPath(input.frontendSourceApp, "frontend source app");
  const finalUserRoot = exactExistingOrFuturePath(input.finalUserRoot, "final user root");
  return {
    paths,
    checkoutSource: ({ sourceRoot, tag, peeledCommit }) => checkoutOfficialCodexSource({
      sourceRoot,
      tag,
      peeledCommit,
    }),
    verifySourceCommit: verifyOfficialCodexSourceCommit,
    buildSource: async ({ sourceRoot, channel, version, peeledCommit }) => {
      if (sourceRoot !== paths.sourceRoot) throw new Error("Codex build source root does not match its transaction path");
      if (process.platform !== "darwin" || process.arch !== "arm64") {
        throw new Error("Codex desktop-derived builds require macOS arm64");
      }
      for (const patchFile of patchFiles) {
        runGit(["apply", "--index", "--check", "--whitespace=error-all", patchFile], sourceRoot);
        runGit(["apply", "--index", "--whitespace=error-all", patchFile], sourceRoot);
      }
      const patchSeriesDigest = digestFiles("patch series", patchFiles);
      const treeDigest = digestTrackedSource(sourceRoot);
      const cargoRoot = join(sourceRoot, "codex-rs");
      const lockfile = exactExistingFile(join(cargoRoot, "Cargo.lock"), "Cargo.lock");
      const rustc = execFileSync("rustc", ["-vV"], { encoding: "utf8", timeout: 10_000 });
      const cargo = execFileSync("cargo", ["-V"], { encoding: "utf8", timeout: 10_000 });
      const rustLifecycleTests = runRustLifecycleReceiptTests({
        cargoRoot,
        evidenceRoot: join(paths.root, "prepared", "rust-lifecycle-tests"),
        sourceCommit: peeledCommit,
        patchedTreeSha256: treeDigest.value,
        cargoLockSha256: sha256File(lockfile),
      });
      execFileSync("cargo", ["build", "--locked", "--release", "--package", "codex-cli", "--bin", "codex"], {
        cwd: cargoRoot,
        stdio: "inherit",
        timeout: 60 * 60 * 1_000,
      });
      const builtBinary = exactExistingFile(join(cargoRoot, "target", "release", "codex"), "built Codex binary");
      const builtVersion = probeCodexBinaryVersion(builtBinary);
      if (builtVersion !== version) throw new Error(`Built Codex version ${builtVersion} does not match ${version}`);

      await buildPatchedCandidateOnly({
        sourceApp: frontendSourceApp,
        destinationApp: paths.candidateApp,
        destinationRuntime: join(paths.root, "candidate", "runtime"),
        finalUserRoot,
      });
      const candidate = locateCodex(paths.candidateApp);
      const candidateBinary = join(candidate.resourcesDir, "codex");
      copyFileSync(builtBinary, candidateBinary);
      chmodSync(candidateBinary, 0o755);
      const signing = signCodexApp(paths.candidateApp, { useLocalIdentity: true });
      const verified = verifySignature(paths.candidateApp);
      if (!signing || !verified.ok) throw new Error(`Derived desktop candidate signature failed: ${verified.output}`);
      if (probeCodexBinaryVersion(candidateBinary) !== version) {
        throw new Error("Staged desktop backend version does not match the built candidate");
      }

      const control = locateCodex(frontendSourceApp);
      const controlBinary = exactExistingFile(join(control.resourcesDir, "codex"), "desktop bundled Codex binary");
      const controlVersion = probeCodexBinaryVersion(controlBinary);
      if (channel === "bundled" && controlVersion !== version) {
        throw new Error(`Desktop bundled control is ${controlVersion}; expected ${version}`);
      }
      const plist = control.metaPath ? readPlist(control.metaPath) : {};
      const frontendVersion = requiredPlistString(plist, "CFBundleShortVersionString");
      const frontendBuild = requiredPlistString(plist, "CFBundleVersion");
      const candidateSignature = signatureInfo(paths.candidateApp);
      if (!candidateSignature.ok) throw new Error("Derived desktop candidate signing identity is unreadable");
      const signature = {
        identity: signing.identity,
        teamIdentifier: candidateSignature.teamIdentifier,
        designatedRequirement: null,
      };
      const platform = "darwin";
      const architecture = "arm64";
      return {
        source: {
          repository: CODEX_RELEASE_REPOSITORY,
          checkoutCommit: peeledCommit,
          archiveDigest: null,
          treeDigest,
          patchSeriesDigest,
          toolchainDigests: [digestText("rustc -vV", rustc), digestText("cargo -V", cargo)],
          lockfileDigests: [digestFile("Cargo.lock", lockfile)],
        },
        dependencies: input.dependencies,
        frontendControl: {
          source: "currently installed desktop frontend at test time",
          platform,
          architecture,
          version: frontendVersion,
          digests: [digestDirectory("desktop frontend Contents", join(frontendSourceApp, "Contents"))],
          signature: signatureFromPath(frontendSourceApp),
          bundleId: control.bundleId ?? "com.openai.codex",
          build: frontendBuild,
          embeddedBackendVersion: controlVersion,
          embeddedBackendDigests: [digestFile("desktop bundled backend", controlBinary)],
        },
        controlBinary: {
          source: "currently installed desktop frontend bundled backend",
          platform,
          architecture,
          version: controlVersion,
          digests: [digestFile("control binary", controlBinary)],
          signature: signatureFromPath(controlBinary),
        },
        candidateBinary: {
          source: "official GitHub tag commit",
          platform,
          architecture,
          version,
          digests: [digestFile("derived candidate binary", candidateBinary)],
          signature,
        },
        rustLifecycleTests: {
          ...rustLifecycleTests,
          candidateBinarySha256: sha256File(candidateBinary),
        },
        ...(input.managedMcp ? { managedMcp: input.managedMcp } : {}),
      };
    },
  };
}

const RUST_LIFECYCLE_REQUIRED_TESTS = [
  /connection_manager::tests::deferred_shutdown_does_not_ignite_never_started_servers$/,
  /connection_manager::tests::cancelled_startup_never_reaches_the_transport$/,
  /connection_manager::tests::shutdown_continues_after_caller_is_aborted$/,
  /connection_manager::tests::capture_binding_exposes_cached_tools_before_startup$/,
  /connection_manager::tests::cancelling_startup_does_not_disable_a_ready_client$/,
  /connection_manager::tests::shutdown_cancels_pending_tool_listing$/,
] as const;

function runRustLifecycleReceiptTests(input: {
  cargoRoot: string;
  evidenceRoot: string;
  sourceCommit: string;
  patchedTreeSha256: string;
  cargoLockSha256: string;
}): Omit<CodexRustLifecycleTestEvidence, "candidateBinarySha256"> {
  const args = ["test", "--locked", "--package", "codex-mcp", "--lib"] as const;
  const startedAt = new Date().toISOString();
  const result = spawnSync("cargo", [...args], {
    cwd: input.cargoRoot,
    encoding: "utf8",
    timeout: 60 * 60 * 1_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const completedAt = new Date().toISOString();
  if (result.error) throw new Error(`Rust lifecycle receipt tests could not run: ${result.error.message}`);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(`Rust lifecycle receipt tests failed with exit ${String(result.status)}: ${stderr.slice(-4_000)}`);
  }
  const passedTests = [...`${stdout}\n${stderr}`.matchAll(/^test\s+([^\s]+)\s+\.\.\.\s+ok\s*$/gm)]
    .map((match) => match[1]!)
    .sort();
  for (const required of RUST_LIFECYCLE_REQUIRED_TESTS) {
    if (!passedTests.some((name) => required.test(name))) {
      throw new Error(`Rust lifecycle receipt tests did not report required proof ${required.source}`);
    }
  }
  mkdirSync(input.evidenceRoot, { recursive: true });
  const stdoutFile = join(input.evidenceRoot, "cargo-test.stdout.log");
  const stderrFile = join(input.evidenceRoot, "cargo-test.stderr.log");
  atomicTextWrite(stdoutFile, Buffer.from(stdout));
  atomicTextWrite(stderrFile, Buffer.from(stderr));
  return {
    schemaVersion: 1,
    kind: "codex-rust-lifecycle-tests",
    sourceCommit: input.sourceCommit,
    patchedTreeSha256: input.patchedTreeSha256,
    cargoLockSha256: input.cargoLockSha256,
    command: ["cargo", ...args],
    exitCode: 0,
    passedTests,
    stdoutFile,
    stdoutSha256: sha256File(stdoutFile),
    stderrFile,
    stderrSha256: sha256File(stderrFile),
    startedAt,
    completedAt,
  };
}

function assertRustLifecycleTestEvidence(
  evidence: CodexRustLifecycleTestEvidence | undefined,
  candidate: CodexPreparedSourceCandidate,
  candidateBinarySha256: string,
): asserts evidence is CodexRustLifecycleTestEvidence {
  if (!evidence
    || evidence.schemaVersion !== 1
    || evidence.kind !== "codex-rust-lifecycle-tests"
    || evidence.sourceCommit !== candidate.evidence.source.checkoutCommit
    || evidence.patchedTreeSha256 !== candidate.evidence.source.treeDigest.value
    || evidence.cargoLockSha256 !== candidate.evidence.source.lockfileDigests.find((item) => item.scope === "Cargo.lock")?.value
    || JSON.stringify(evidence.command) !== JSON.stringify(["cargo", "test", "--locked", "--package", "codex-mcp", "--lib"])
    || evidence.exitCode !== 0
    || evidence.candidateBinarySha256 !== candidateBinarySha256
    || !validTimestamp(evidence.startedAt)
    || !validTimestamp(evidence.completedAt)
    || Date.parse(evidence.startedAt) > Date.parse(evidence.completedAt)
    || !Array.isArray(evidence.passedTests)) {
    throw new Error("Prepared candidate lacks exact green Rust lifecycle receipt evidence");
  }
  const stdout = requireInternalAbsoluteFile(evidence.stdoutFile, "Rust lifecycle stdout evidence");
  const stderr = requireInternalAbsoluteFile(evidence.stderrFile, "Rust lifecycle stderr evidence");
  if (sha256File(stdout) !== evidence.stdoutSha256 || sha256File(stderr) !== evidence.stderrSha256) {
    throw new Error("Rust lifecycle test output evidence drifted after build");
  }
  for (const required of RUST_LIFECYCLE_REQUIRED_TESTS) {
    if (!evidence.passedTests.some((name) => required.test(name))) {
      throw new Error(`Rust lifecycle receipt lacks required proof ${required.source}`);
    }
  }
}

/**
 * Resolve the candidate app a bundled-derived receipt points at. Receipts live
 * at `<root>/codex-source/receipts/<id>.json`, so the user root is three
 * levels up; the candidate location itself must always come from
 * `codexSourceTransactionPaths` so the consumer can never drift from the path
 * the build and canary actually write.
 */
export function bundledDerivedCandidateAppPathForReceipt(
  receiptFile: string,
  transactionId: string,
): string {
  const userRoot = dirname(dirname(dirname(receiptFile)));
  return codexSourceTransactionPaths(userRoot, transactionId).candidateApp;
}

/**
 * Fail-closed handoff consumed by desktop-candidate preparation. The path is
 * derived from the receipt transaction ID, then version, digest, and app
 * signature are re-probed before the artifact can be embedded or selected.
 */
export function readValidatedBundledDerivedArtifact(
  receiptPath: string,
  now: string = new Date().toISOString(),
): ValidatedBundledDerivedArtifact {
  const exactReceipt = exactExistingFile(receiptPath, "bundled-derived receipt");
  const readable = readCodexDerivedReceipt(exactReceipt);
  if (!readable || readable.schemaVersion !== CODEX_DERIVED_RECEIPT_SCHEMA_VERSION) {
    throw new Error("Bundled-derived receipt is missing or is not schema v2");
  }
  const receipt = readable;
  if (receipt.channel !== "bundled" || receipt.label !== codexDerivedLabel("bundled", receipt.version)) {
    throw new Error("Receipt does not describe a desktop-bundled-derived artifact");
  }
  if (!["canary-passed", "promoting", "promoted", "soaking", "completed"].includes(receipt.phase)) {
    throw new Error(
      `Bundled-derived receipt is not eligible in phase ${receipt.phase}; an isolated canary must pass first`,
    );
  }
  const restartWindow = receipt.resolution.restartWindow;
  if (
    !restartWindow
    || !validTimestamp(now)
    || Date.parse(now) < Date.parse(restartWindow.opensAt)
    || Date.parse(now) > Date.parse(restartWindow.closesAt)
  ) {
    throw new Error("Bundled-derived receipt is outside its frozen restart window");
  }
  if (!receipt.managedMcp) throw new Error("Bundled-derived receipt predates complete managed MCP fleet evidence");
  assertManagedMcpPreparedRuntimeEvidence(receipt.managedMcp);
  const codexSourceRoot = dirname(dirname(exactReceipt));
  const candidateApp = bundledDerivedCandidateAppPathForReceipt(exactReceipt, receipt.transactionId);
  const binaryPath = exactExistingFile(join(candidateApp, "Contents", "Resources", "codex"), "bundled-derived binary");
  const fingerprint = sha256File(binaryPath);
  const expected = receipt.candidateBinary.digests.find((digest) =>
    digest.algorithm === "sha256" && digest.scope === "derived candidate binary"
  )?.value;
  if (!expected || fingerprint !== expected.toLowerCase()) {
    throw new Error("Bundled-derived binary digest does not match its receipt");
  }
  assertReceiptCanaryReference(receipt, codexSourceRoot, binaryPath, fingerprint);
  const version = probeCodexBinaryVersion(binaryPath);
  if (version !== receipt.version || receipt.candidateBinary.version !== version) {
    throw new Error("Bundled-derived binary version does not match its receipt");
  }
  const signature = verifySignature(candidateApp);
  if (!signature.ok) throw new Error(`Bundled-derived candidate signature is invalid: ${signature.output}`);
  return { binaryPath, version, fingerprint, receiptPath: exactReceipt, transactionId: receipt.transactionId };
}

function defaultCommandDependencies(): CodexSourceCommandDependencies {
  const fetchJson = createGitHubJsonFetcher();
  return {
    root: () => userPaths().root,
    probeBundledVersion: probeInstalledBundledCodexVersion,
    fetchJson,
    resolveTag: createGitHubTagResolver(fetchJson),
    fetchNpmVersions: () => fetchNpmCodexVersions(),
    now: () => new Date().toISOString(),
    print: (value) => console.log(value),
    production: defaultProductionDependencies(),
  };
}

function defaultProductionDependencies(): CodexSourceProductionDependencies {
  return {
    stageManagedMcpPackages: stageCodexManagedMcpPackages,
    prepareManagedMcpLifecycle: prepareManagedMcpLifecycleRuntime,
    createCanaryObservationAdapter: (input) => createManagedMcpAppServerObservationAdapter(input),
    createBuildAdapter: createProductionCodexSourceBuildAdapter,
    prepareCandidate: prepareCodexSourceCandidate,
    freezeCandidate: freezeCodexSourceCandidate,
    assertFrontendControlParity,
    transactionId: randomUUID,
  };
}

function prepareIsolatedPluginMarketplace(
  managedMcp: ManagedMcpPreparedRuntimeEvidence,
  marketplaceRoot: string,
  marketplaceName: string,
): CodexSourcePluginInstallInput["plugins"] {
  const plugins = managedMcp.artifacts.filter((artifact) => artifact.kind === "plugin-bundle").map((artifact) => {
    if (!artifact.destination || !artifact.version || !artifact.runtimeRelativePath) {
      throw new Error(`Managed MCP plugin bundle ${artifact.id} is not installable`);
    }
    const parts = artifact.runtimeRelativePath.split("/");
    const pluginId = parts[1];
    if (parts.length !== 3 || !pluginId) throw new Error(`Managed MCP plugin bundle ${artifact.id} has an invalid path`);
    const sourcePath = join(marketplaceRoot, "plugins", pluginId);
    mkdirSync(dirname(sourcePath), { recursive: true });
    cpSync(artifact.destination, sourcePath, { recursive: true, verbatimSymlinks: true });
    const copy = attestManagedMcpArtifact(sourcePath, "plugin-bundle");
    if (copy.sha256 !== artifact.sha256 || copy.entryCount !== artifact.entryCount) {
      throw new Error(`Isolated marketplace plugin ${pluginId} drifted during staging`);
    }
    return {
      artifactId: artifact.id,
      pluginId,
      version: artifact.version,
      sourcePath,
      sha256: artifact.sha256,
      entryCount: artifact.entryCount,
    };
  }).sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  if (plugins.length === 0) throw new Error("Managed MCP fleet has no receipt-bound plugin bundles");
  atomicJsonWrite(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), {
    name: marketplaceName,
    interface: { displayName: "Codex On-Demand Canary" },
    plugins: plugins.map((plugin) => ({
      name: plugin.pluginId,
      source: { source: "local", path: `./plugins/${plugin.pluginId}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    })),
  });
  return plugins;
}

function installPluginsWithCandidateManager(
  input: CodexSourcePluginInstallInput,
): readonly CodexSourceInstalledPluginEvidence[] {
  const env = { ...process.env, CODEX_HOME: input.codexHome };
  execFileSync(input.candidatePath, ["plugin", "marketplace", "add", input.marketplaceRoot, "--json"], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return input.plugins.map((plugin) => {
    const bytes = execFileSync(
      input.candidatePath,
      ["plugin", "add", `${plugin.pluginId}@${input.marketplaceName}`, "--json"],
      { env, stdio: ["ignore", "pipe", "inherit"] },
    );
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Candidate plugin manager returned invalid JSON for ${plugin.pluginId}: ${String(error)}`);
    }
    if (!isRecord(value)) throw new Error(`Candidate plugin manager returned invalid evidence for ${plugin.pluginId}`);
    return {
      artifactId: plugin.artifactId,
      owner: `plugin:${plugin.pluginId}@${String(value.version)}`,
      pluginId: plugin.pluginId,
      version: String(value.version),
      installedPath: String(value.installedPath),
      sha256: plugin.sha256,
      entryCount: plugin.entryCount,
    };
  });
}

function assertInstalledPluginFleet(
  expected: CodexSourcePluginInstallInput["plugins"],
  installed: readonly CodexSourceInstalledPluginEvidence[],
  codexHome: string,
  marketplaceName: string,
): void {
  if (installed.length !== expected.length) throw new Error("Candidate plugin manager did not install the complete fleet");
  for (const plugin of expected) {
    const actual = installed.find((candidate) => candidate.artifactId === plugin.artifactId);
    if (!actual
      || actual.pluginId !== plugin.pluginId
      || actual.version !== plugin.version
      || actual.owner !== `plugin:${plugin.pluginId}@${plugin.version}`
      || actual.sha256 !== plugin.sha256
      || actual.entryCount !== plugin.entryCount
      || !isAbsolute(actual.installedPath)
      || resolve(actual.installedPath) !== actual.installedPath
      || (actual.installedPath !== codexHome && !actual.installedPath.startsWith(`${codexHome}/`))) {
      throw new Error(`Candidate plugin manager evidence drift for ${plugin.pluginId}@${marketplaceName}`);
    }
    const attested = attestManagedMcpArtifact(actual.installedPath, "plugin-bundle");
    if (attested.sha256 !== plugin.sha256 || attested.entryCount !== plugin.entryCount) {
      throw new Error(`Installed plugin bundle drift for ${plugin.pluginId}`);
    }
  }
}

export function managedMcpCanaryExpectedRoutes(
  runtime: ManagedMcpPreparedRuntimeEvidence,
): readonly ManagedMcpCanaryExpectedRoute[] {
  const overlay = readAndVerifyManagedMcpLifecycleOverlay(runtime.overlayFile);
  return overlay.entries.map((entry) => {
    let catalog: unknown;
    try { catalog = JSON.parse(readFileSync(entry.catalog.path, "utf8")); } catch (error) {
      throw new Error(`Managed MCP catalog is unreadable for ${entry.owner}/${entry.server}: ${String(error)}`);
    }
    if (!isRecord(catalog) || !Array.isArray(catalog.tools)) {
      throw new Error(`Managed MCP catalog lacks tools for ${entry.owner}/${entry.server}`);
    }
    const tool = catalog.tools.find((item) => isRecord(item) && typeof item.name === "string" && item.name.length > 0);
    if (!isRecord(tool) || typeof tool.name !== "string") {
      throw new Error(`Managed MCP catalog has no representative tool for ${entry.owner}/${entry.server}`);
    }
    if (!Array.isArray(catalog.artifacts) || catalog.artifacts.length === 0) {
      throw new Error(`Managed MCP catalog lacks receipt-bound artifacts for ${entry.owner}/${entry.server}`);
    }
    const artifactKeys = new Set<string>();
    const artifactRows = catalog.artifacts.map((artifact) => {
      if (!isRecord(artifact) || typeof artifact.path !== "string" || typeof artifact.sha256 !== "string") return null;
      const artifactPath = isAbsolute(artifact.path) ? artifact.path : resolve(dirname(entry.catalog.path), artifact.path);
      const digest = artifact.sha256.startsWith("sha256:") ? artifact.sha256.slice("sha256:".length) : artifact.sha256;
      if (!isAbsolute(artifactPath) || resolve(artifactPath) !== artifactPath || !/^[a-f0-9]{64}$/.test(digest)) return null;
      const key = `${artifactPath}\0${digest}`;
      if (artifactKeys.has(key)) throw new Error(`Managed MCP catalog contains a duplicate artifact for ${entry.owner}/${entry.server}`);
      artifactKeys.add(key);
      const exactArtifact = requireInternalAbsoluteFile(artifactPath, `managed MCP artifact for ${entry.owner}/${entry.server}`);
      if (sha256File(exactArtifact) !== digest) {
        throw new Error(`Managed MCP catalog artifact digest drift for ${entry.owner}/${entry.server}`);
      }
      return { path: exactArtifact, sha256: digest };
    });
    if (!artifactRows.every(
      (artifact): artifact is { path: string; sha256: string } => artifact !== null,
    )) {
      throw new Error(`Managed MCP catalog artifact digest is invalid for ${entry.owner}/${entry.server}`);
    }
    const artifacts = artifactRows;
    const artifactSha256 = artifacts.map((artifact) => artifact.sha256);
    const representativeArguments = isRecord(tool.representativeArguments)
      ? tool.representativeArguments
      : isRecord(tool.representative_arguments)
        ? tool.representative_arguments
        : {};
    return {
      owner: entry.owner,
      server: entry.server,
      lifecycle: entry.lifecycle,
      idleLeaseSec: entry.idleLeaseSec,
      declarationFingerprint: entry.declarationFingerprint,
      catalogSha256: entry.catalog.sha256,
      artifactSha256: artifactSha256 as string[],
      artifacts,
      representativeTool: tool.name,
      representativeArguments,
    };
  });
}

function reconcileIsolatedGlobalMcpConfig(file: string, plan: ManagedMcpPreparedRuntimeEvidence["configReconciliation"]): void {
  const original = readFileSync(file, "utf8");
  if (/^\s*\[mcp_servers(?:\.|\])/m.test(original)) {
    throw new Error("Isolated Codex config unexpectedly contains pre-existing global MCP routes");
  }
  const blocks = plan.routes.filter((route) => route.action !== "archive-shadow").map((route) => {
    const declaration = route.effectiveDeclaration;
    if (!declaration) throw new Error(`Config route ${route.server} lacks a materialized declaration`);
    const lines = [
      `[mcp_servers.${JSON.stringify(route.server)}]`,
      `command = ${JSON.stringify(declaration.command)}`,
      `args = ${JSON.stringify(declaration.args)}`,
    ];
    if (declaration.cwd !== null) lines.push(`cwd = ${JSON.stringify(declaration.cwd)}`);
    if (Object.keys(declaration.explicitEnv).length > 0) {
      const env = Object.entries(declaration.explicitEnv).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ");
      lines.push(`env = { ${env} }`);
    }
    return lines.join("\n");
  });
  atomicTextWrite(file, Buffer.from(`${original.trimEnd()}\n\n${blocks.join("\n\n")}\n`));
}

export function probeInstalledBundledCodexVersion(app?: string): string {
  // Source resolution must bind to one named desktop truth surface. The
  // generic locator deliberately falls back across installed channels, which
  // could turn a missing ChatGPT.app into a Codex/Beta source selection.
  const install = process.platform === "darwin"
    ? locateCodexAtExactPath(app ?? "/Applications/ChatGPT.app")
    : locateCodex(app);
  const binary = join(install.resourcesDir, "codex");
  const output = execFileSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  }).trim();
  const match = /^codex-cli (.+)$/.exec(output);
  const version = match?.[1];
  if (!version || !parseSemver(version)) throw new Error("Installed desktop bundled Codex version is invalid");
  return version;
}

function checkpointFromResolution(
  name: CodexResolutionCheckpoint["name"],
  resolution: Awaited<ReturnType<typeof resolveCodexSourceRelease>>,
  peeled: TagPeelIdentity,
): CodexResolutionCheckpoint {
  if (peeled.tag !== resolution.resolvedTag) throw new Error("Resolved tag and peeled tag disagree");
  return {
    name,
    channel: resolution.channel,
    endpoint: resolution.endpoint,
    resolvedTag: resolution.resolvedTag,
    normalizedVersion: resolution.normalizedVersion,
    peeledCommit: peeled.peeledCommit,
    checkedAt: resolution.checkedAt,
    etag: resolution.etag,
    responseBodySha256: resolution.responseBodySha256,
    tagObjectShas: peeled.tagObjectShas,
  };
}

function authoritativeSameChannelFloor(
  root: string,
  channel: CodexSourceChannel,
): Partial<Record<CodexSourceChannel, ChannelPromotionFloor>> {
  const directory = join(root, "codex-source", "receipts");
  if (!existsSync(directory)) return {};
  let floor: ChannelPromotionFloor | null = null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const readable = readCodexDerivedReceipt(join(directory, entry.name));
    if (!readable || readable.schemaVersion !== CODEX_DERIVED_RECEIPT_SCHEMA_VERSION) continue;
    if (
      readable.channel !== channel
      || !["promoted", "soaking", "completed"].includes(readable.phase)
      || readable.error !== null
      || readable.supersededBy !== null
    ) continue;
    const candidate = {
      version: readable.version,
      peeledCommit: readable.resolution.peeledCommit,
    };
    if (!floor) {
      floor = candidate;
      continue;
    }
    const comparison = compareSemverPrecedence(candidate.version, floor.version);
    if (comparison === 0 && candidate.peeledCommit !== floor.peeledCommit) {
      throw new Error(`Authoritative ${channel} receipts disagree on the commit for ${candidate.version}`);
    }
    if (comparison > 0) floor = candidate;
  }
  return floor ? { [channel]: floor } : {};
}

function lockedDependenciesFromManagedMcp(
  staged: ManagedMcpStageEvidence,
): readonly LockedDependencyEvidence[] {
  return staged.packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    integrity: pkg.integrity,
    entrypoint: pkg.routes[0]?.command ?? null,
    contentDigests: [
      namedSha256("managed MCP release lock", pkg.lockSha256),
      namedSha256("managed MCP catalog file", pkg.catalogFileSha256),
      namedSha256("managed MCP catalog semantics", pkg.catalogDigestSha256),
      namedSha256("managed MCP package lock", pkg.packageLockSha256),
      namedSha256("managed MCP dependency graph", pkg.dependencyGraphDigestSha256),
      namedSha256("managed MCP locked wrapper", pkg.wrapperSha256),
    ],
  }));
}

function namedSha256(scope: string, value: string): { algorithm: "sha256"; value: string; scope: string } {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`Managed MCP ${scope} digest is invalid`);
  return { algorithm: "sha256", value: value.toLowerCase(), scope };
}

function parsePatchSeries(value: string | readonly string[] | undefined): readonly string[] {
  const files = typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [...(value ?? [])];
  if (files.length === 0) {
    throw new Error("codex-source build requires --patch-series with one or more exact absolute patch files");
  }
  return files;
}

function parseRestartWindow(opensAt: string | undefined, closesAt: string | undefined): RestartWindow {
  if (!opensAt || !closesAt || !Number.isFinite(Date.parse(opensAt)) || !Number.isFinite(Date.parse(closesAt))) {
    throw new Error("codex-source build requires valid --restart-window-opens-at and --restart-window-closes-at timestamps");
  }
  if (Date.parse(opensAt) >= Date.parse(closesAt)) {
    throw new Error("Codex source restart window must close after it opens");
  }
  return {
    opensAt: new Date(Date.parse(opensAt)).toISOString(),
    closesAt: new Date(Date.parse(closesAt)).toISOString(),
  };
}

function optionValue<
  Camel extends keyof CodexSourceOptions,
  Kebab extends keyof CodexSourceOptions,
>(
  options: CodexSourceOptions,
  camel: Camel,
  kebab: Kebab,
): CodexSourceOptions[Camel] | CodexSourceOptions[Kebab] | undefined {
  return options[camel] ?? options[kebab];
}

function assertMinimumBuildFreeSpace(path: string, available: bigint): void {
  if (available < MINIMUM_BUILD_FREE_BYTES) {
    throw new Error(
      `Codex source build requires ${MINIMUM_BUILD_FREE_BYTES.toString()} bytes free on ${path}; `
      + `${available.toString()} bytes are available`,
    );
  }
}

function filesystemAvailableBytes(path: string): bigint {
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`Cannot resolve filesystem for Codex source root ${path}`);
    existing = parent;
  }
  const stats = statfsSync(existing, { bigint: true });
  return stats.bsize * stats.bavail;
}

function readPreparedSourceCandidate(file: string, transactionId: string): CodexPreparedSourceCandidate {
  const exact = requireInternalAbsoluteFile(file, "prepared Codex source candidate state");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(exact, "utf8"));
  } catch (error) {
    throw new Error(`Prepared Codex source candidate state is unreadable: ${String(error)}`);
  }
  if (!isRecord(value)) throw new Error("Prepared Codex source candidate state is invalid");
  const candidate = value as unknown as CodexPreparedSourceCandidate;
  if (
    candidate.schemaVersion !== 1
    || candidate.kind !== "codex-source-candidate"
    || candidate.transactionId !== transactionId
    || (candidate.channel !== "bundled" && candidate.channel !== "stable" && candidate.channel !== "edge")
    || !isRecord(candidate.cycle)
    || candidate.cycle.status !== "active"
    || !Array.isArray(candidate.cycle.checkpoints)
    || candidate.cycle.checkpoints.length !== 2
    || candidate.cycle.checkpoints[0]?.name !== "R1"
    || candidate.cycle.checkpoints[1]?.name !== "R2"
    || !isRecord(candidate.evidence)
  ) throw new Error("Prepared Codex source candidate state is not an active R1/R2 build");
  assertBuildEvidence(candidate.evidence, candidate.cycle.checkpoints[1]!);
  return candidate;
}

function readStrictIsolatedCanaryEvidence(file: string): CodexSourceIsolatedCanaryEvidence {
  const bytes = readFileSync(file);
  if (bytes.length === 0) throw new Error("Isolated canary evidence is empty");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Isolated canary evidence is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(value)) throw new Error("Isolated canary evidence is invalid");
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "status",
    "transactionId",
    "version",
    "candidate",
    "isolatedHome",
    "lifecycle",
    "managedMcp",
    "pluginBundles",
    "trustedRunner",
    "trustedObservationAdapter",
    "observations",
    "startedAt",
    "completedAt",
  ], "isolated canary evidence");
  if (!isRecord(value.candidate)
    || !isRecord(value.isolatedHome)
    || !isRecord(value.lifecycle)
    || !isRecord(value.managedMcp)
    || !Array.isArray(value.pluginBundles)
    || !isRecord(value.trustedRunner)
    || !isRecord(value.trustedObservationAdapter)
    || !isRecord(value.observations)) {
    throw new Error("Isolated canary evidence candidate or lifecycle matrix is missing");
  }
  const candidate = value.candidate;
  const isolatedHome = value.isolatedHome;
  const lifecycle = value.lifecycle;
  const managedMcp = value.managedMcp;
  const pluginBundles = value.pluginBundles;
  const trustedRunner = value.trustedRunner;
  const trustedObservationAdapter = value.trustedObservationAdapter;
  assertExactKeys(candidate, ["path", "sha256"], "isolated canary candidate");
  assertExactKeys(
    managedMcp,
    [
      "runtimeRoot",
      "managedPackageRoot",
      "runtimeTreeSha256",
      "overlayPath",
      "overlaySha256",
      "fleetFingerprint",
      "requiredCoverage",
      "mcpOnDemandEnabled",
    ],
    "isolated canary managed MCP evidence",
  );
  assertExactKeys(isolatedHome, ["root", "configPath", "configSha256"], "isolated canary home");
  for (const [index, pluginBundle] of pluginBundles.entries()) {
    if (!isRecord(pluginBundle)) throw new Error(`Invalid isolated canary plugin bundle ${index}`);
    assertExactKeys(pluginBundle, ["owner", "installedPath", "sha256", "routeOwnerProven"], `isolated canary plugin bundle ${index}`);
  }
  assertExactKeys(trustedRunner, ["identity", "attestationSha256"], "isolated canary trusted runner");
  assertExactKeys(trustedObservationAdapter, ["identity", "attestationSha256"], "isolated canary trusted observation adapter");
  const lifecycleKeys = [
    "zeroBeforeDiscovery",
    "launchOnCall",
    "cleanupAfterSuccess",
    "cleanupAfterTaskClose",
    "cleanupAfterAppShutdown",
    "callScopedReturnsToZero",
    "taskScopedReuseWithinLease",
    "taskScopedIsolation",
    "playwrightProfilesIndependent",
    "allExpectedToolsCallable",
    "noCatalogMismatch",
    "noPackageDrift",
    "noOrphanedParent",
  ];
  assertExactKeys(lifecycle, lifecycleKeys, "isolated canary lifecycle matrix");
  if (
    value.schemaVersion !== 1
    || value.kind !== "managed-mcp-observed-canary"
    || value.status !== "passed"
    || typeof value.transactionId !== "string"
    || typeof value.version !== "string"
    || !parseSemver(value.version)
    || typeof candidate.path !== "string"
    || !isAbsolute(candidate.path)
    || resolve(candidate.path) !== candidate.path
    || typeof candidate.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.sha256)
    || typeof isolatedHome.root !== "string"
    || !isAbsolute(isolatedHome.root)
    || resolve(isolatedHome.root) !== isolatedHome.root
    || typeof isolatedHome.configPath !== "string"
    || !isAbsolute(isolatedHome.configPath)
    || resolve(isolatedHome.configPath) !== isolatedHome.configPath
    || typeof isolatedHome.configSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(isolatedHome.configSha256)
    || typeof managedMcp.runtimeRoot !== "string"
    || !isAbsolute(managedMcp.runtimeRoot)
    || resolve(managedMcp.runtimeRoot) !== managedMcp.runtimeRoot
    || typeof managedMcp.managedPackageRoot !== "string"
    || !isAbsolute(managedMcp.managedPackageRoot)
    || resolve(managedMcp.managedPackageRoot) !== managedMcp.managedPackageRoot
    || typeof managedMcp.runtimeTreeSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(managedMcp.runtimeTreeSha256)
    || typeof managedMcp.overlayPath !== "string"
    || !isAbsolute(managedMcp.overlayPath)
    || resolve(managedMcp.overlayPath) !== managedMcp.overlayPath
    || typeof managedMcp.overlaySha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(managedMcp.overlaySha256)
    || typeof managedMcp.fleetFingerprint !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(managedMcp.fleetFingerprint)
    || !Array.isArray(managedMcp.requiredCoverage)
    || !managedMcp.requiredCoverage.every((item) => typeof item === "string")
    || managedMcp.mcpOnDemandEnabled !== true
    || pluginBundles.length === 0
    || pluginBundles.some((item) => !isRecord(item)
      || typeof item.owner !== "string"
      || typeof item.installedPath !== "string"
      || !isAbsolute(item.installedPath)
      || resolve(item.installedPath) !== item.installedPath
      || typeof item.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(item.sha256)
      || item.routeOwnerProven !== true)
    || typeof trustedRunner.identity !== "string"
    || trustedRunner.identity.length === 0
    || typeof trustedRunner.attestationSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(trustedRunner.attestationSha256)
    || typeof trustedObservationAdapter.identity !== "string"
    || trustedObservationAdapter.identity.length === 0
    || typeof trustedObservationAdapter.attestationSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(trustedObservationAdapter.attestationSha256)
    || lifecycleKeys.some((key) => lifecycle[key] !== true)
    || !validTimestamp(value.startedAt)
    || !validTimestamp(value.completedAt)
    || Date.parse(value.startedAt) > Date.parse(value.completedAt)
  ) throw new Error("Isolated canary evidence did not prove the required lifecycle matrix");
  return value as unknown as CodexSourceIsolatedCanaryEvidence;
}

function assertValidatedCanarySidecar(
  file: string,
  candidate: CodexPreparedSourceCandidate,
  paths: CodexSourceTransactionPaths,
): CodexCanaryEvidenceReference {
  const exact = requireInternalAbsoluteFile(file, "validated isolated canary sidecar");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(exact, "utf8"));
  } catch (error) {
    throw new Error(`Validated isolated canary sidecar is unreadable: ${String(error)}`);
  }
  if (!isRecord(value)) throw new Error("Validated isolated canary sidecar is invalid");
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "transactionId",
    "sourceFile",
    "sourceSha256",
    "version",
    "candidatePath",
    "candidateSha256",
    "isolatedHome",
    "lifecycle",
    "managedMcp",
    "installedManagedMcp",
    "pluginBundles",
    "trustedRunner",
    "trustedObservationAdapter",
    "canaryStartedAt",
    "canaryCompletedAt",
    "recordedAt",
  ], "validated isolated canary sidecar");
  const sourceFile = typeof value.sourceFile === "string"
    ? requireInternalAbsoluteFile(value.sourceFile, "isolated canary source evidence")
    : "";
  const strict = readStrictIsolatedCanaryEvidence(sourceFile);
  const managedMcp = candidate.evidence.managedMcp;
  if (!managedMcp) throw new Error("Prepared candidate lacks complete managed MCP fleet evidence");
  if (!isRecord(value.installedManagedMcp)) throw new Error("Validated canary lacks installed managed MCP evidence");
  const installedManagedMcp = value.installedManagedMcp as unknown as ManagedMcpPreparedRuntimeEvidence;
  assertManagedMcpPreparedRuntimeEvidence(installedManagedMcp);
  const trustedRunner = candidate.evidence.trustedCanaryRunner;
  if (!trustedRunner) throw new Error("Prepared candidate lacks repository-owned canary runner evidence");
  assertManagedMcpCanaryEvidence(strict, {
    transactionId: candidate.transactionId,
    version: candidate.evidence.candidateBinary.version,
    candidatePath: strict.candidate.path,
    candidateSha256: strict.candidate.sha256,
    codexHome: strict.isolatedHome.root,
    configPath: strict.isolatedHome.configPath,
    configSha256: strict.isolatedHome.configSha256,
    managedRuntime: installedManagedMcp,
    pluginBundles: strict.pluginBundles.map(({ owner, installedPath, sha256 }) => ({ owner, installedPath, sha256 })),
    expectedRoutes: managedMcpCanaryExpectedRoutes(installedManagedMcp),
    trustedRunnerExpectedSha256: trustedRunner.sha256,
    trustedAdapterExpectedSha256: candidate.evidence.trustedCanaryAdapter?.sha256 ?? "",
    rustLifecycleTests: candidate.evidence.rustLifecycleTests!,
  });
  const expectedCandidate = join(paths.candidateApp, "Contents", "Resources", "codex");
  const candidateSha256 = sha256File(requireInternalAbsoluteFile(expectedCandidate, "source-derived canary candidate"));
  if (
    value.schemaVersion !== 1
    || value.kind !== "codex-source-canary-evidence"
    || value.transactionId !== candidate.transactionId
    || value.version !== candidate.evidence.candidateBinary.version
    || value.candidatePath !== expectedCandidate
    || value.candidateSha256 !== candidateSha256
    || value.sourceSha256 !== sha256File(sourceFile)
    || strict.transactionId !== candidate.transactionId
    || strict.version !== value.version
    || strict.candidate.path !== expectedCandidate
    || strict.candidate.sha256 !== candidateSha256
    || JSON.stringify(value.isolatedHome) !== JSON.stringify(strict.isolatedHome)
    || JSON.stringify(value.lifecycle) !== JSON.stringify(strict.lifecycle)
    || JSON.stringify(value.managedMcp) !== JSON.stringify(strict.managedMcp)
    || JSON.stringify(value.pluginBundles) !== JSON.stringify(strict.pluginBundles)
    || JSON.stringify(value.trustedRunner) !== JSON.stringify(strict.trustedRunner)
    || JSON.stringify(value.trustedObservationAdapter) !== JSON.stringify(strict.trustedObservationAdapter)
    || strict.isolatedHome.root !== paths.canaryHome
    || strict.isolatedHome.configPath !== join(paths.canaryHome, "config.toml")
    || strict.isolatedHome.configSha256 !== sha256File(strict.isolatedHome.configPath)
    || strict.managedMcp.runtimeRoot !== installedManagedMcp.runtimeRoot
    || strict.managedMcp.managedPackageRoot !== installedManagedMcp.managedPackageRoot
    || strict.managedMcp.runtimeTreeSha256 !== installedManagedMcp.runtimeTreeSha256
    || strict.managedMcp.overlayPath !== installedManagedMcp.overlayFile
    || strict.managedMcp.overlaySha256 !== installedManagedMcp.overlaySha256
    || strict.managedMcp.fleetFingerprint !== installedManagedMcp.fleetFingerprint
    || installedManagedMcp.sourceFleetFingerprint !== managedMcp.fleetFingerprint
    || JSON.stringify(strict.managedMcp.requiredCoverage) !== JSON.stringify(installedManagedMcp.requiredCoverage)
    || value.canaryStartedAt !== strict.startedAt
    || value.canaryCompletedAt !== strict.completedAt
    || !validTimestamp(value.recordedAt)
  ) throw new Error("Validated isolated canary sidecar is not bound to the prepared candidate");
  return {
    schemaVersion: 1,
    kind: "codex-source-canary-reference",
    sidecarPath: exact,
    sidecarSha256: sha256File(exact),
    candidatePath: expectedCandidate,
    candidateSha256,
    managedMcpOverlaySha256: strict.managedMcp.overlaySha256,
    managedMcpFleetFingerprint: managedMcp.fleetFingerprint,
    trustedRunnerIdentity: strict.trustedRunner.identity,
    trustedRunnerAttestationSha256: strict.trustedRunner.attestationSha256,
    trustedObservationAdapterIdentity: strict.trustedObservationAdapter.identity,
    trustedObservationAdapterAttestationSha256: strict.trustedObservationAdapter.attestationSha256,
    startedAt: strict.startedAt,
    completedAt: strict.completedAt,
  };
}

function assertReceiptCanaryReference(
  receipt: CodexDerivedReceipt,
  codexSourceRoot: string,
  candidatePath: string,
  candidateSha256: string,
): void {
  const reference = receipt.canary;
  if (!reference) throw new Error("Bundled-derived receipt does not reference strict isolated canary evidence");
  const managedMcp = receipt.managedMcp;
  if (!managedMcp) throw new Error("Bundled-derived receipt predates complete managed MCP fleet evidence");
  const expectedSidecar = join(
    codexSourceRoot,
    "transactions",
    receipt.transactionId,
    "canary-evidence.json",
  );
  if (
    reference.sidecarPath !== expectedSidecar
    || reference.candidatePath !== candidatePath
    || reference.candidateSha256 !== candidateSha256
    || reference.managedMcpFleetFingerprint !== managedMcp.fleetFingerprint
  ) throw new Error("Bundled-derived receipt canary reference does not match its candidate transaction");
  const sidecar = requireInternalAbsoluteFile(reference.sidecarPath, "receipt canary sidecar");
  if (sha256File(sidecar) !== reference.sidecarSha256) {
    throw new Error("Bundled-derived receipt canary sidecar digest does not match");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(sidecar, "utf8"));
  } catch (error) {
    throw new Error(`Bundled-derived receipt canary sidecar is unreadable: ${String(error)}`);
  }
  if (!isRecord(value) || typeof value.sourceFile !== "string" || !isRecord(value.installedManagedMcp)) {
    throw new Error("Bundled-derived receipt canary sidecar is invalid");
  }
  const sourceFile = requireInternalAbsoluteFile(value.sourceFile, "receipt canary source evidence");
  const strict = readStrictIsolatedCanaryEvidence(sourceFile);
  const installedManagedMcp = value.installedManagedMcp as unknown as ManagedMcpPreparedRuntimeEvidence;
  assertManagedMcpPreparedRuntimeEvidence(installedManagedMcp);
  if (
    value.kind !== "codex-source-canary-evidence"
    || value.transactionId !== receipt.transactionId
    || value.version !== receipt.version
    || value.candidatePath !== candidatePath
    || value.candidateSha256 !== candidateSha256
    || value.sourceSha256 !== sha256File(sourceFile)
    || strict.transactionId !== receipt.transactionId
    || strict.version !== receipt.version
    || strict.candidate.path !== candidatePath
    || strict.candidate.sha256 !== candidateSha256
    || strict.managedMcp.overlaySha256 !== reference.managedMcpOverlaySha256
    || installedManagedMcp.sourceFleetFingerprint !== reference.managedMcpFleetFingerprint
    || strict.managedMcp.fleetFingerprint !== installedManagedMcp.fleetFingerprint
    || strict.trustedRunner.identity !== reference.trustedRunnerIdentity
    || strict.trustedRunner.attestationSha256 !== reference.trustedRunnerAttestationSha256
    || strict.trustedObservationAdapter.identity !== reference.trustedObservationAdapterIdentity
    || strict.trustedObservationAdapter.attestationSha256 !== reference.trustedObservationAdapterAttestationSha256
    || strict.startedAt !== reference.startedAt
    || strict.completedAt !== reference.completedAt
  ) throw new Error("Bundled-derived receipt canary evidence is not bound to its receipt");
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireTransactionId(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Codex source transaction ID is missing or invalid");
  }
  return value;
}

function requireNonEmptyOption(value: string | readonly string[] | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
  return value;
}

function requireInternalAbsoluteFile(value: string | undefined, label: string): string {
  const path = requireInternalAbsolutePath(value, label, true);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return path;
}

function requireInternalAbsolutePath(
  value: string | undefined,
  label: string,
  mustExist: boolean,
): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label} must be an exact absolute path`);
  }
  assertInternalStoragePath(value, label);
  if (mustExist && !existsSync(value)) throw new Error(`${label} must exist at ${value}`);
  return value;
}

function untouchedWatcherEvidence(): WatcherPromotionEvidence {
  return {
    previousFingerprints: {},
    promotedFingerprints: {},
    pauseTokenDigest: null,
    expectedFingerprintUpdatedAt: null,
    rearmedAt: null,
    wasEnabled: false,
  };
}

function parseAction(value: string): CodexSourceAction {
  if (
    value === "build"
    || value === "canary-pass"
    || value === "freeze"
    || value === "cutover"
    || value === "rollback"
    || value === "detect"
    || value === "resolve"
    || value === "status"
  ) return value;
  throw new Error("Codex source action must be build, canary-pass, freeze, cutover, rollback, detect, resolve, or status");
}

function parseChannel(value: string | undefined): CodexSourceChannel {
  if (value === undefined || value === "bundled") return "bundled";
  if (value === "stable" || value === "edge") return value;
  throw new Error("Codex source channel must be bundled, stable, or edge");
}

function requireExactVersion(value: string | undefined): string {
  const parsed = value ? parseSemver(value) : null;
  if (!parsed) throw new Error("Bundled Codex source resolution requires the installed backend version");
  return parsed.normalized;
}

function assertExactCommit(label: string, actual: string, expected: string): void {
  if (!validCommit(actual) || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} is ${actual || "missing"}; expected peeled commit ${expected}`);
  }
}

function assertBuildEvidence(evidence: CodexSourceBuildEvidence, checkpoint: CodexResolutionCheckpoint): void {
  if (evidence.managedMcp) assertManagedMcpPreparedRuntimeEvidence(evidence.managedMcp);
  assertExactCommit("build evidence checkout", evidence.source.checkoutCommit, checkpoint.peeledCommit);
  if (evidence.candidateBinary.version !== checkpoint.normalizedVersion) {
    throw new Error("Built candidate version does not match the resolved source version");
  }
  if (evidence.candidateBinary.source !== "official GitHub tag commit") {
    throw new Error("Built candidate source must be the official GitHub tag commit");
  }
}

function gitIdentityFromRefResponse(response: GitHubJsonResponse, endpoint: string): GitObjectIdentity {
  assertGitHubSuccess(response, endpoint);
  const value = response.data as { object?: { sha?: unknown; type?: unknown } } | undefined;
  return gitIdentity(value?.object, endpoint);
}

function gitIdentityFromTagResponse(response: GitHubJsonResponse, endpoint: string): GitObjectIdentity {
  assertGitHubSuccess(response, endpoint);
  const value = response.data as { object?: { sha?: unknown; type?: unknown } } | undefined;
  return gitIdentity(value?.object, endpoint);
}

function gitIdentity(value: { sha?: unknown; type?: unknown } | undefined, endpoint: string): GitObjectIdentity {
  if (!value || !validCommit(value.sha) || (value.type !== "commit" && value.type !== "tag")) {
    throw new Error(`GitHub returned an invalid Git object at ${endpoint}`);
  }
  return { sha: value.sha, type: value.type };
}

function assertGitHubSuccess(response: GitHubJsonResponse, endpoint: string): void {
  if (response.status !== 200) throw new Error(`GitHub Git object lookup failed (${response.status}) at ${endpoint}`);
}

function parseGitHubNextUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/.exec(part);
    if (!match || match[2] !== "next") continue;
    const url = new URL(match[1]);
    if (url.origin !== GITHUB_API_ORIGIN || url.pathname !== `/repos/${CODEX_RELEASE_REPOSITORY}/releases`) {
      throw new Error("GitHub pagination escaped the official Codex releases endpoint");
    }
    return url.toString();
  }
  return null;
}

function githubHeaders(): Readonly<Record<string, string>> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": CODEX_GITHUB_API_VERSION,
  };
}

function readAdvisoryCache(
  file: string,
  channel: CodexSourceChannel,
  bundledVersion: string | null,
): AdvisoryCacheFile | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<AdvisoryCacheFile>;
    if (value.schemaVersion !== 1 || value.channel !== channel || value.bundledVersion !== bundledVersion
      || typeof value.lastAttemptAt !== "string" || typeof value.nextAttemptAt !== "string"
      || !Number.isFinite(Date.parse(value.lastAttemptAt)) || !Number.isFinite(Date.parse(value.nextAttemptAt))) return null;
    return value as AdvisoryCacheFile;
  } catch {
    return null;
  }
}

function atomicJsonWrite(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function atomicTextWrite(file: string, bytes: Buffer): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function printCommandResult(
  result:
    | CodexSourceResolutionResult
    | DailyCodexSourceDetectionResult
    | CodexDerivedReceipt
    | CodexSourceBuildCommandResult
    | CodexSourceCanaryPassResult
    | CodexSourceFreezeCommandResult
    | CodexSourceCutoverReceipt
    | null,
  options: CodexSourceOptions,
  deps: Pick<CodexSourceCommandDependencies, "print">,
): void {
  if (options.json !== false) {
    deps.print(JSON.stringify(result));
    return;
  }
  if (result === null) deps.print("No Codex source receipt is installed for this channel.");
  else deps.print(JSON.stringify(result, null, 2));
}

function runGit(args: readonly string[], cwd?: string): string {
  return execFileSync("git", [...args], {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function probeCodexBinaryVersion(binary: string): string {
  const output = execFileSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  }).trim();
  const version = /^codex-cli (.+)$/.exec(output)?.[1];
  if (!version || !parseSemver(version)) throw new Error(`Codex binary returned an invalid version at ${binary}`);
  return version;
}

function exactExistingFile(path: string, label: string): string {
  const exact = resolve(path);
  if (!isAbsolute(path) || exact !== path) throw new Error(`${label} path must be exact and absolute`);
  assertInternalStoragePath(exact, label);
  const info = lstatSync(exact);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return exact;
}

function exactExistingPath(path: string, label: string): string {
  const exact = resolve(path);
  if (!isAbsolute(path) || exact !== path) throw new Error(`${label} must be an exact absolute path`);
  assertInternalStoragePath(exact, label);
  if (!existsSync(exact)) throw new Error(`${label} must exist`);
  return exact;
}

function exactExistingOrFuturePath(path: string, label: string): string {
  const exact = resolve(path);
  if (!isAbsolute(path) || exact !== path) throw new Error(`${label} must be an exact absolute path`);
  assertInternalStoragePath(exact, label);
  return exact;
}

export function assertInternalStoragePath(path: string, label = "Codex artifact"): void {
  assertInternalFilesystemPath(path, label);
}

function digestFile(scope: string, file: string): { algorithm: "sha256"; value: string; scope: string } {
  return { algorithm: "sha256", value: sha256File(file), scope };
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function digestText(scope: string, value: string): { algorithm: "sha256"; value: string; scope: string } {
  return { algorithm: "sha256", value: createHash("sha256").update(value).digest("hex"), scope };
}

function digestFiles(scope: string, files: readonly string[]): { algorithm: "sha256"; value: string; scope: string } {
  const hash = createHash("sha256");
  for (const [index, file] of files.entries()) {
    hash.update(String(index));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return { algorithm: "sha256", value: hash.digest("hex"), scope };
}

function digestTrackedSource(sourceRoot: string): { algorithm: "sha256"; value: string; scope: string } {
  // `git apply` leaves newly added patch files untracked in the disposable
  // checkout. Include them so the receipt commits to the complete patched
  // tree, not only files that existed in the upstream tag.
  const files = runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], sourceRoot)
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(sourceRoot, file)));
    hash.update("\0");
  }
  return { algorithm: "sha256", value: hash.digest("hex"), scope: "patched source tree" };
}

function digestDirectory(scope: string, root: string): { algorithm: "sha256"; value: string; scope: string } {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      hash.update(relative(root, path));
      hash.update("\0");
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) hash.update(`symlink:${readlinkSync(path)}`);
      else if (entry.isFile()) hash.update(readFileSync(path));
      hash.update("\0");
    }
  };
  visit(root);
  return { algorithm: "sha256", value: hash.digest("hex"), scope };
}

function signatureFromPath(path: string): ArtifactEvidence["signature"] {
  const info = signatureInfo(path);
  if (!info.ok) return null;
  return {
    identity: info.authority[0] ?? (info.adHoc ? "ad-hoc" : "local identity"),
    teamIdentifier: info.teamIdentifier,
    designatedRequirement: null,
  };
}

function requiredPlistString(plist: Record<string, unknown>, key: string): string {
  const value = plist[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Desktop frontend is missing ${key}`);
  return value;
}

function validCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
}

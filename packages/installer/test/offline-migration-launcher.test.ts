import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  OFFLINE_MIGRATION_LAUNCHER_ATTEMPT_FILE,
  OFFLINE_MIGRATION_LAUNCHER_CONTEXT_FILE,
  OFFLINE_MIGRATION_LAUNCHER_TERMINAL_RESULT_FILE,
  OFFLINE_MIGRATION_LAUNCHER_WAITING_FILE,
  OFFLINE_MIGRATION_MANAGER_RUN_COMMAND,
  OfflineMigrationLauncherError,
  armOfflineMigrationLauncher,
  inspectOfflineMigrationLauncher,
  offlineMigrationLauncherCommand,
  offlineMigrationLauncherPaths,
  prepareOfflineMigrationLauncher,
  readOfflineMigrationLauncherContext,
  runOfflineMigrationLauncher,
  runOfflineMigrationLauncherManagerCommand,
  type OfflineMigrationLauncherContextV1,
  type OfflineMigrationLauncherDependencies,
  type OfflineMigrationManagerExecutionRoute,
  type OfflineMigrationLauncherPrepareInput,
  type OfflineMigrationLaunchctl,
  type OfflineMigrationLaunchctlResult,
  type OfflineMigrationTweakersRuntimeReadyProbeInput,
  type OfflineMigrationTweakersRuntimeReadyProbeResult,
  type OfflineMigrationWriterCensus,
} from "../src/offline-migration-launcher.ts";
import type {
  SharedHistoryCapacityReceiptInspectionInput,
  SharedHistoryCapacityReceiptInspectionV1,
  SharedHistoryMigrationResult,
  SharedHistoryRollbackView,
} from "../src/shared-history-migration.ts";
import {
  REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS,
  TWEAKERS_ORIGINAL_EXECUTABLE,
} from "../src/macos-variant.ts";
import { MANAGER_PROTOCOL_VERSION, TWEAKERS_MANAGER_ID } from "../src/manager-contract.ts";
import {
  TWEAKERS_MANAGER_BUNDLE_NAME,
  TWEAKERS_MANAGER_LAUNCHER_NAME,
  TWEAKERS_MANAGER_SEAL_NAME,
  createTweakersManagerGenerationId,
  serializeTweakersManagerTargetSeal,
} from "../src/manager-descriptor.ts";
import { canonicalSha256Fingerprint } from "../src/account-history-adoption.ts";

const APPROVED_TRANSACTION = "948cbf37-e706-408a-ac12-fbd66fa3c659";
const OTHER_TRANSACTION = "migration-launcher-20260904-b";
const NOW = "2026-09-04T12:00:00.000Z";
const SHA = `sha256:${"a".repeat(64)}` as const;
const TEMPORARY_ROOT = realpathSync(tmpdir());
const FIXTURE_PLUGIN = { pluginId: "fixture@registry", version: "1.0.0" } as const;
const FIXTURE_CAPACITY_RECEIPT = "{\"fixture\":\"shared-history-capacity-receipt\"}\n";

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function privateFile(path: string, value: string, mode = 0o600): void {
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
}

function sha256(path: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function idleCensus(): OfflineMigrationWriterCensus {
  return {
    observedAt: NOW,
    chatgptWriters: 0,
    tweakersWriters: 0,
    brokerWriters: 0,
    historyWriters: 0,
  };
}

function fixtureRuntimeReadyProbe(
  input: OfflineMigrationTweakersRuntimeReadyProbeInput,
): OfflineMigrationTweakersRuntimeReadyProbeResult {
  return {
    process: {
      pid: input.expectedPid,
      processStartToken: "fixture-process-start-token",
      command: `${join(input.appRoot, "Contents", "MacOS", TWEAKERS_ORIGINAL_EXECUTABLE)} --user-data-dir=${join(dirname(input.receiptPath), "tweakers-user-data")}`,
    },
    appAsarHeaderHash: "d".repeat(64),
    runtimeFingerprint: "c".repeat(64),
  };
}

function fixtureCapacityReceiptInspector(
  input: SharedHistoryCapacityReceiptInspectionInput,
): SharedHistoryCapacityReceiptInspectionV1 {
  if (input.legacyDefinitionsRoot === undefined
    || input.sharedSkillsRoots === undefined
    || input.sharedPluginInventory === undefined) {
    throw new OfflineMigrationLauncherError("shared-history-capacity-receipt-definition-binding-incomplete");
  }
  if (readFileSync(input.capacityReceiptPath, "utf8") !== FIXTURE_CAPACITY_RECEIPT) {
    throw new OfflineMigrationLauncherError("shared-history-capacity-receipt-hmac-invalid");
  }
  const receipt = lstatSync(input.capacityReceiptPath);
  const rootBinding = (path: string) => {
    const stat = lstatSync(path);
    return {
      path,
      device: stat.dev,
      inode: stat.ino,
      uid: stat.uid,
      mode: stat.mode & 0o777,
      nlink: stat.nlink,
    };
  };
  return {
    version: 1,
    kind: "shared-history-capacity-receipt-inspection",
    receipt: {
      path: input.capacityReceiptPath,
      bytes: receipt.size,
      sha256: sha256(input.capacityReceiptPath),
      device: receipt.dev,
      inode: receipt.ino,
      uid: receipt.uid,
      mode: receipt.mode & 0o777,
      nlink: receipt.nlink,
    },
    issuedAt: NOW,
    proof: {
      configFingerprint: SHA,
      protocolFingerprint: SHA,
      poolFingerprint: SHA,
      intentFingerprint: SHA,
      adoptionReceiptFingerprint: SHA,
      sourceFingerprint: SHA,
      destinationFingerprint: SHA,
      ownersFingerprint: SHA,
      aliasesFingerprint: null,
    },
    sources: {
      routerManifestFingerprint: SHA,
      sourceDatabaseManifestFingerprint: SHA,
      normalizedSourceDatabaseManifestFingerprint: SHA,
      sharedSkillsManifestFingerprint: SHA,
      sharedPluginsManifestFingerprint: SHA,
      definitionsRoot: rootBinding(input.legacyDefinitionsRoot),
    },
    projection: {
      snapshot: { bytes: 1, sha256: SHA },
      journal: { bytes: 1, sha256: SHA },
      sourceEvidence: { bytes: 1, sha256: SHA },
    },
    roots: {
      router: rootBinding(input.legacyRouterRoot),
      codex: rootBinding(input.legacyCodexRoot),
      sqlite: rootBinding(input.legacySqliteRoot),
      definitions: rootBinding(input.legacyDefinitionsRoot),
    },
  };
}

function prepareFixture(
  input: OfflineMigrationLauncherPrepareInput,
  dependencies: Pick<OfflineMigrationLauncherDependencies, "now" | "runtimeReadyProbe" | "inspectCapacityReceipt"> = {},
) {
  return prepareOfflineMigrationLauncher(input, {
    now: () => NOW,
    runtimeReadyProbe: fixtureRuntimeReadyProbe,
    inspectCapacityReceipt: fixtureCapacityReceiptInspector,
    ...dependencies,
  });
}

function armFixture(
  launcherRoot: string,
  dependencies: OfflineMigrationLauncherDependencies = {},
) {
  return armOfflineMigrationLauncher(launcherRoot, {
    inspectCapacityReceipt: fixtureCapacityReceiptInspector,
    ...dependencies,
  });
}

function migratedResult(
  transactionId: string,
  sharedSkillsTrustedRoots: readonly string[] = [],
): SharedHistoryMigrationResult {
  return {
    status: "migrated",
    transactionId,
    sourceFingerprint: SHA,
    candidateFingerprint: SHA,
    conversationCount: 1,
    segmentCount: 1,
    sharedSkillsFingerprint: SHA,
    sharedSkillsTrustedRoots,
    sharedSkillsTrustedRootsFingerprint: SHA,
    sharedPluginsFingerprint: SHA,
    sharedPluginInventoryFingerprint: SHA,
    sharedPluginExclusionsFingerprint: SHA,
    sharedPluginIds: [],
    sharedPluginPackages: [],
    nextAction: "activate-remains-user-confirmed",
  };
}

function v3Rollback(): SharedHistoryRollbackView {
  return {
    state: "ready",
    canonicalFingerprint: SHA,
    conversationCount: 1,
    segmentCount: 1,
    requiresBrokerWriteStop: true,
    legacySqliteFlattened: false,
  };
}

function publishMigratedFixture(context: OfflineMigrationLauncherContextV1): SharedHistoryMigrationResult {
  privateDirectory(context.migration.globalRoot);
  const parent = dirname(context.migration.globalRoot);
  const globalRootName = basename(context.migration.globalRoot);
  const treePayload = { directories: [], files: [], links: [] };
  const manifest = { ...treePayload, fingerprint: canonicalSha256Fingerprint(treePayload) };
  const trustedRoots = context.migration.sharedSkillsRoots.map((path) => {
    const stat = lstatSync(path);
    return { path, device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
  });
  const trustedRootsFingerprint = canonicalSha256Fingerprint(trustedRoots);
  const sharedSkillsPayload = {
    directories: [],
    files: [],
    trustedRoots,
    trustedRootsFingerprint,
  };
  const sharedSkills = {
    version: 1,
    kind: "account-router-shared-skills",
    ...sharedSkillsPayload,
    fingerprint: canonicalSha256Fingerprint(sharedSkillsPayload),
  } as const;
  const inventory = { version: 1, plugins: [FIXTURE_PLUGIN] };
  const inventoryFingerprint = canonicalSha256Fingerprint(inventory);
  const exclusionsFingerprint = canonicalSha256Fingerprint([]);
  const pluginPackage = {
    pluginId: FIXTURE_PLUGIN.pluginId,
    registry: "registry",
    name: "fixture",
    version: FIXTURE_PLUGIN.version,
    fingerprint: canonicalSha256Fingerprint(treePayload),
    exclusionsFingerprint,
    excludedFiles: [],
    fileCount: 0,
    bytes: 0,
  };
  const sharedPluginsPayload = {
    inventoryFingerprint,
    exclusionsFingerprint,
    packages: [pluginPackage],
  };
  const sharedPlugins = {
    version: 1,
    kind: "account-router-shared-plugins",
    ...sharedPluginsPayload,
    fingerprint: canonicalSha256Fingerprint(sharedPluginsPayload),
  } as const;
  privateFile(context.migrationJournalPath, `${JSON.stringify({
    version: 2,
    kind: "shared-history-migration",
    id: context.transactionId,
    legacyRouterRoot: context.migration.legacyRouterRoot,
    legacyCodexRoot: context.migration.legacyCodexRoot,
    legacySqliteRoot: context.migration.legacySqliteRoot,
    legacyDefinitionsRoot: context.migration.legacyDefinitionsRoot,
    globalRoot: context.migration.globalRoot,
    snapshotRoot: join(parent, `.${globalRootName}.shared-history-pre-migration-${context.transactionId}`),
    candidateRoot: join(parent, `.${globalRootName}.shared-history-candidate-${context.transactionId}`),
    quarantineRoot: join(parent, `.${globalRootName}.shared-history-quarantine-${context.transactionId}`),
    phase: "published",
    preAdoptionManifest: manifest,
    preMigrationManifest: manifest,
    candidateManifest: manifest,
    canonical: { fingerprint: SHA, conversationCount: 1, segmentCount: 1 },
    sharedPluginInventoryFingerprint: inventoryFingerprint,
    sharedPluginExclusionsFingerprint: exclusionsFingerprint,
    sharedSkills,
    sharedPlugins,
  })}\n`);
  return {
    status: "migrated",
    transactionId: context.transactionId,
    sourceFingerprint: manifest.fingerprint,
    candidateFingerprint: manifest.fingerprint,
    conversationCount: 1,
    segmentCount: 1,
    sharedSkillsFingerprint: sharedSkills.fingerprint,
    sharedSkillsTrustedRoots: context.migration.sharedSkillsRoots,
    sharedSkillsTrustedRootsFingerprint: trustedRootsFingerprint,
    sharedPluginsFingerprint: sharedPlugins.fingerprint,
    sharedPluginInventoryFingerprint: inventoryFingerprint,
    sharedPluginExclusionsFingerprint: exclusionsFingerprint,
    sharedPluginIds: [FIXTURE_PLUGIN.pluginId],
    sharedPluginPackages: [FIXTURE_PLUGIN],
    nextAction: "activate-remains-user-confirmed",
  };
}

function managerRunArguments(context: OfflineMigrationLauncherContextV1): string[] {
  const contextPath = offlineMigrationLauncherPaths(context.launcherRoot).context;
  return [
    OFFLINE_MIGRATION_MANAGER_RUN_COMMAND,
    "--launcher-root",
    context.launcherRoot,
    "--context-bytes",
    String(lstatSync(contextPath).size),
    "--context-sha256",
    sha256(contextPath),
  ];
}

function managerRunnerDependencies(
  context: OfflineMigrationLauncherContextV1,
  launchctl: OfflineMigrationLaunchctl,
  dependencies: Omit<OfflineMigrationLauncherDependencies, "launchctl" | "currentExecutionRoute" | "currentProcessId" | "currentParentProcessId" | "managerInvocation"> = {},
  argv = managerRunArguments(context),
): OfflineMigrationLauncherDependencies {
  const route: OfflineMigrationManagerExecutionRoute = {
    pid: process.pid,
    nodePath: context.executor.node.path,
    managerBundlePath: context.executor.managerBundle.path,
    argv,
  };
  return {
    inspectCapacityReceipt: fixtureCapacityReceiptInspector,
    ...dependencies,
    launchctl,
    currentProcessId: () => process.pid,
    currentParentProcessId: () => 1,
    currentExecutionRoute: () => route,
  };
}

function runManagerWorker(
  context: OfflineMigrationLauncherContextV1,
  launchctl: OfflineMigrationLaunchctl,
  dependencies: Omit<OfflineMigrationLauncherDependencies, "launchctl" | "currentExecutionRoute" | "currentProcessId" | "currentParentProcessId" | "managerInvocation"> = {},
  argv = managerRunArguments(context),
) {
  return runOfflineMigrationLauncherManagerCommand(
    argv,
    managerRunnerDependencies(context, launchctl, dependencies, argv),
  );
}

class FakeLaunchctl implements OfflineMigrationLaunchctl {
  readonly labels = new Set<string>();
  readonly calls: string[] = [];
  private readonly jobs = new Map<string, {
    plistPath: string;
    program: string;
    arguments: readonly string[];
    state: "running" | "exited";
    pid: number;
  }>();
  private readonly printOverrides = new Map<string, string>();
  private readonly printResultOverrides = new Map<string, OfflineMigrationLaunchctlResult>();

  bootstrap(domain: string, plistPath: string) {
    this.calls.push("bootstrap");
    const plist = readFileSync(plistPath, "utf8");
    const label = plist.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    const argumentsBlock = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
    const argumentsList = [...argumentsBlock.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]!);
    if (!label || argumentsList.length < 3) return { status: 1, error: "missing-launchd-identity" };
    const service = `${domain}/${label}`;
    this.labels.add(service);
    this.jobs.set(service, {
      plistPath,
      program: argumentsList[0]!,
      arguments: argumentsList,
      state: "running",
      pid: process.pid,
    });
    return { status: 0 };
  }

  bootout(_domain: string, service: string) {
    this.calls.push("bootout");
    this.labels.delete(service);
    this.jobs.delete(service);
    this.printOverrides.delete(service);
    this.printResultOverrides.delete(service);
    return { status: 0 };
  }

  print(service: string) {
    this.calls.push(`print:${this.labels.has(service) ? "loaded" : "absent"}`);
    const overriddenResult = this.printResultOverrides.get(service);
    if (overriddenResult !== undefined) return overriddenResult;
    const job = this.jobs.get(service);
    if (!job) return { status: 113 };
    return { status: 0, output: this.printOverrides.get(service) ?? actualLaunchctlPrint(service, job) };
  }

  setWorkerState(service: string, state: "running" | "exited", pid = process.pid): void {
    const job = this.jobs.get(service);
    assert.ok(job, "fixture launchd job must exist");
    job.state = state;
    job.pid = pid;
  }

  setPrintOverride(service: string, output: string): void {
    this.printOverrides.set(service, output);
  }

  setPrintResult(service: string, result: OfflineMigrationLaunchctlResult): void {
    this.printResultOverrides.set(service, result);
  }
}

function actualLaunchctlPrint(
  service: string,
  job: { plistPath: string; program: string; arguments: readonly string[]; state: string; pid: number },
): string {
  // This mirrors launchctl print's one-tab top-level field grammar and its
  // two-tab arguments block, including unrelated nested data that must not
  // influence the service identity proof.
  return [
    `${service} = {`,
    `\tpath = ${job.plistPath}`,
    "\ttype = LaunchAgent",
    `\tstate = ${job.state}`,
    "\tjetsam memory limit (active) = (unlimited)",
    "\tjetsam memory limit (inactive) = (unlimited)",
    "\tmanaged_by = launchd",
    "",
    `\tprogram = ${job.program}`,
    "\targuments = {",
    ...job.arguments.map((entry) => `\t\t${entry}`),
    "\t}",
    `\tpid = ${job.pid}`,
    "\tenvironment = {",
    "\t\tPATH => /usr/bin:/bin",
    "\t}",
    "}",
    "",
  ].join("\n");
}

class BootstrapFailureLaunchctl extends FakeLaunchctl {
  override bootstrap(domain: string, plistPath: string) {
    super.bootstrap(domain, plistPath);
    return { status: 1, error: "fixture-bootstrap-failure" };
  }
}

class Fixture {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-offline-migration-launcher-")));
  readonly launchAgentsRoot = join(this.root, "LaunchAgents");
  readonly launcherRoot = join(this.root, "launcher");
  readonly managerNode = join(this.root, "sealed-node");
  readonly managerGenerationsRoot = join(this.root, "managers", TWEAKERS_MANAGER_ID, "generations");
  readonly managerGenerationRoot: string;
  readonly managerBundle: string;
  readonly managerLauncher: string;
  readonly managerTargetSeal: string;
  readonly routerRoot = join(this.root, "legacy-router");
  readonly legacyCodexRoot = join(this.root, "legacy-codex");
  readonly legacySqliteRoot = join(this.root, "legacy-sqlite");
  readonly legacyDefinitionsRoot = join(this.root, "legacy-definitions");
  readonly sharedSkillsRoot = join(this.root, "shared-skills-source");
  readonly sharedPluginInventory = join(this.root, "plugins.v1.json");
  readonly additionalInventory = join(this.root, "skills.v1.json");
  readonly capacityReceipt = join(this.root, "shared-history-capacity-receipt.v1.json");
  readonly globalRoot = join(this.root, "global-v3");
  readonly chatgptApp = join(this.root, "ChatGPT.app");
  readonly tweakersApp = join(this.root, "Tweakers.app");
  readonly appUserDataRoot = join(this.root, "tweakers-user-data");
  readonly codexHomeRoot = join(this.root, "tweakers-codex-home");
  readonly accountsBrokerRoot = this.globalRoot;
  readonly promotionReceipt = join(this.root, "runtime-ready.json");

  constructor() {
    for (const path of [
      this.launchAgentsRoot,
      this.routerRoot,
      this.legacyCodexRoot,
      this.legacySqliteRoot,
      this.legacyDefinitionsRoot,
      this.sharedSkillsRoot,
      this.chatgptApp,
      this.tweakersApp,
      this.appUserDataRoot,
      this.codexHomeRoot,
    ]) privateDirectory(path);
    privateDirectory(join(this.root, "managers"));
    privateDirectory(join(this.root, "managers", TWEAKERS_MANAGER_ID));
    privateDirectory(this.managerGenerationsRoot);
    privateFile(this.managerNode, "fixture node executable\n", 0o500);
    const managerBundleText = "// fixture single-file manager bundle\n";
    const managerLauncherText = "fixture manager launcher\n";
    const managerSha256 = sha256Text(managerBundleText);
    const launcherSha256 = sha256Text(managerLauncherText);
    const nodeSha256 = sha256Text(readFileSync(this.managerNode, "utf8"));
    const generationBase = {
      managerId: TWEAKERS_MANAGER_ID,
      protocolVersion: MANAGER_PROTOCOL_VERSION,
      launcherSha256,
      nodePath: this.managerNode,
      nodeSha256,
      managerSha256,
      managedRuntimeFingerprint: "e".repeat(64),
    } as const;
    const generationId = createTweakersManagerGenerationId(generationBase);
    this.managerGenerationRoot = join(this.managerGenerationsRoot, generationId);
    this.managerBundle = join(this.managerGenerationRoot, TWEAKERS_MANAGER_BUNDLE_NAME);
    this.managerLauncher = join(this.managerGenerationRoot, TWEAKERS_MANAGER_LAUNCHER_NAME);
    this.managerTargetSeal = join(this.managerGenerationRoot, TWEAKERS_MANAGER_SEAL_NAME);
    privateDirectory(this.managerGenerationRoot);
    privateFile(this.managerBundle, managerBundleText, 0o400);
    privateFile(this.managerLauncher, managerLauncherText, 0o500);
    privateFile(this.managerTargetSeal, serializeTweakersManagerTargetSeal({
      ...generationBase,
      generationId,
    }), 0o400);
    privateFile(this.sharedPluginInventory, `${JSON.stringify({ version: 1, plugins: [FIXTURE_PLUGIN] })}\n`);
    privateFile(this.additionalInventory, '{"version":1,"skills":[]}\n');
    privateFile(this.capacityReceipt, FIXTURE_CAPACITY_RECEIPT);
    this.writePromotionReceipt();
  }

  writePromotionReceipt(overrides: Record<string, unknown> = {}): void {
    privateFile(this.promotionReceipt, `${JSON.stringify({
      schemaVersion: 5,
      kind: "tweakers-independent-runtime-ready",
      operationId: "independent-operation-20260904",
      promotionId: "independent-promotion-20260904",
      activePromotionReceiptSha256: "b".repeat(64),
      pid: 4242,
      processStartToken: "fixture-process-start-token",
      runtimeFingerprint: "c".repeat(64),
      appAsarHeaderHash: "d".repeat(64),
      appRoot: this.tweakersApp,
      bundleId: "com.therealityreport.tweakers",
      appUserDataRoot: this.appUserDataRoot,
      codexHomeRoot: this.codexHomeRoot,
      accountsBrokerRoot: this.accountsBrokerRoot,
      brokerAuthorityExpectation: {
        globalRootState: "absent",
        configSha256: null,
      },
      appearance: {
        status: "normal",
        normalized: true,
      },
      mainInitialized: true,
      preloadInitialized: true,
      settingsMounted: true,
      sharedHistoryBrokerState: "blocked",
      initializedTweakIds: [...REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS],
      observedAt: NOW,
      ...overrides,
    })}\n`);
  }

  input(transactionId = APPROVED_TRANSACTION): OfflineMigrationLauncherPrepareInput {
    return {
      transactionId,
      launcherRoot: this.launcherRoot,
      launchAgentsRoot: this.launchAgentsRoot,
      managerGeneration: { generationRoot: this.managerGenerationRoot },
      migration: {
        legacyRouterRoot: this.routerRoot,
        legacyCodexRoot: this.legacyCodexRoot,
        legacySqliteRoot: this.legacySqliteRoot,
        globalRoot: this.globalRoot,
        appPath: this.chatgptApp,
        tweakersAppPath: this.tweakersApp,
        sharedSkillsRoots: [this.sharedSkillsRoot],
        sharedPluginInventory: this.sharedPluginInventory,
        capacityReceiptPath: this.capacityReceipt,
      },
      sealedInventoryPaths: [this.additionalInventory],
      tweakersPromotionReceipt: this.promotionReceipt,
      tweakersPromotionFingerprint: sha256(this.promotionReceipt),
    };
  }
}

test("preparation binds any valid transaction ID and arms only a private RunAtLoad one-shot plist", () => {
  const fixture = new Fixture();
  const context = prepareFixture(fixture.input());
  assert.equal(context.transactionId, APPROVED_TRANSACTION);
  assert.equal(context.label.endsWith(APPROVED_TRANSACTION), true);
  assert.equal(existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_CONTEXT_FILE)), true);
  assert.equal(lstatSync(fixture.launcherRoot).mode & 0o7777, 0o700);

  const launchctl = new FakeLaunchctl();
  const armed = armFixture(fixture.launcherRoot, { launchctl });
  assert.equal(armed.state, "armed");
  assert.equal(armed.plistPath.startsWith(fixture.launchAgentsRoot), true);
  assert.equal(lstatSync(context.plistPath).mode & 0o7777, 0o600);
  const plist = readFileSync(context.plistPath, "utf8");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, new RegExp(`<string>${context.label}</string>`));
  assert.match(plist, new RegExp(`<string>${context.executor.node.path}</string>`));
  assert.match(plist, new RegExp(`<string>${context.executor.managerBundle.path}</string>`));
  assert.match(plist, new RegExp(`<string>${OFFLINE_MIGRATION_MANAGER_RUN_COMMAND}</string>`));
  assert.match(plist, new RegExp(`<string>${managerRunArguments(context)[6]!}</string>`), "the fixed argv carries the raw context seal, not a spoofable environment marker");
  assert.doesNotMatch(plist, /EnvironmentVariables/);
  assert.doesNotMatch(plist, /\/usr\/bin\/env|#!|PATH/, "launchd receives the sealed absolute Node route directly");
  assert.equal(context.promotion.accountsBrokerRoot, context.migration.globalRoot);
  assert.deepEqual(context.promotion.brokerAuthorityExpectation, {
    globalRootState: "absent",
    configSha256: null,
  });
  assert.deepEqual(context.promotion.appearance, { status: "normal", normalized: true });
  assert.doesNotMatch(plist, /submit/);
  assert.deepEqual(launchctl.calls.filter((entry) => entry === "bootstrap"), ["bootstrap"]);
  assert.equal(fixture.launchAgentsRoot.startsWith(TEMPORARY_ROOT), true, "the test never uses the real LaunchAgents directory");
});

test("launcher contexts seal definitions and capacity receipts, while old contexts remain inspectable but unarmable", () => {
  const explicit = new Fixture();
  const explicitContext = prepareFixture({
    ...explicit.input(),
    migration: { ...explicit.input().migration, legacyDefinitionsRoot: explicit.legacyDefinitionsRoot },
  });
  assert.equal(explicitContext.migration.legacyDefinitionsRoot, explicit.legacyDefinitionsRoot);
  assert.equal(explicitContext.migration.capacityReceiptPath, explicit.capacityReceipt);
  assert.equal(explicitContext.capacityReceipt?.receipt.path, explicit.capacityReceipt);
  assert.equal(explicitContext.inventories.some((entry) => entry.path === explicit.capacityReceipt), true);

  const legacy = new Fixture();
  const prepared = prepareFixture(legacy.input());
  const contextPath = offlineMigrationLauncherPaths(legacy.launcherRoot).context;
  const raw = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, unknown>;
  delete (raw.migration as Record<string, unknown>).legacyDefinitionsRoot;
  delete (raw.migration as Record<string, unknown>).capacityReceiptPath;
  delete raw.capacityReceipt;
  privateFile(contextPath, `${JSON.stringify(raw)}\n`);
  const recovered = readOfflineMigrationLauncherContext(legacy.launcherRoot);
  assert.equal(recovered.migration.legacyDefinitionsRoot, legacy.legacyCodexRoot);
  assert.equal(recovered.migration.capacityReceiptPath, undefined);
  assert.equal(inspectOfflineMigrationLauncher(legacy.launcherRoot, { launchctl: new FakeLaunchctl() }).state, "prepared");
  const launchctl = new FakeLaunchctl();
  assert.throws(
    () => armFixture(legacy.launcherRoot, { launchctl }),
    /shared-history-capacity-receipt-required/,
  );
  assert.equal(launchctl.calls.includes("bootstrap"), false);
  assert.equal(existsSync(legacy.launcherRoot), true, "inspection and refusal leave the historical context available");
  assert.equal(prepared.migration.legacyDefinitionsRoot, legacy.legacyCodexRoot);
});

test("an armed historical context without a capacity receipt stops before waiting or migration", () => {
  const fixture = new Fixture();
  const current = prepareFixture(fixture.input());
  const launchctl = new FakeLaunchctl();
  armFixture(fixture.launcherRoot, { launchctl });

  const contextPath = offlineMigrationLauncherPaths(fixture.launcherRoot).context;
  const currentBytes = String(lstatSync(contextPath).size);
  const currentHash = sha256(contextPath);
  const raw = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, unknown>;
  delete (raw.migration as Record<string, unknown>).legacyDefinitionsRoot;
  delete (raw.migration as Record<string, unknown>).capacityReceiptPath;
  delete raw.capacityReceipt;
  privateFile(contextPath, `${JSON.stringify(raw)}\n`);
  const historical = readOfflineMigrationLauncherContext(fixture.launcherRoot);
  const historicalBytes = String(lstatSync(contextPath).size);
  const historicalHash = sha256(contextPath);

  let plist = readFileSync(current.plistPath, "utf8");
  assert.equal(plist.includes(`<string>${currentBytes}</string>`), true);
  assert.equal(plist.includes(`<string>${currentHash}</string>`), true);
  plist = plist.replace(`<string>${currentBytes}</string>`, `<string>${historicalBytes}</string>`)
    .replace(`<string>${currentHash}</string>`, `<string>${historicalHash}</string>`);
  privateFile(current.plistPath, plist);
  const uid = process.getuid?.();
  assert.equal(typeof uid, "number");
  const service = `gui/${uid}/${historical.label}`;
  launchctl.bootout(`gui/${uid}`, service);
  assert.equal(launchctl.bootstrap(`gui/${uid}`, historical.plistPath).status, 0);

  let migrations = 0;
  const terminal = runManagerWorker(historical, launchctl, {
    now: () => NOW,
    writerCensus: idleCensus,
    migrate: () => {
      migrations += 1;
      return publishMigratedFixture(historical);
    },
  });
  assert.equal(terminal.state, "manual-recovery-required");
  assert.equal(terminal.reason, "shared-history-capacity-receipt-required");
  assert.equal(migrations, 0, "a historical context cannot execute without a capacity receipt");
  assert.equal(existsSync(offlineMigrationLauncherPaths(fixture.launcherRoot).waiting), false);
  assert.equal(existsSync(offlineMigrationLauncherPaths(fixture.launcherRoot).attempt), false);
});

test("capacity receipts are mandatory and reject tampering or source-root rebinding before launcher mutation", () => {
  const missing = new Fixture();
  assert.throws(
    () => prepareFixture({
      ...missing.input(),
      migration: { ...missing.input().migration, capacityReceiptPath: undefined },
    }),
    /shared-history-capacity-receipt-required/,
  );
  assert.equal(existsSync(missing.launcherRoot), false, "missing proof cannot create a launcher context");

  const tampered = new Fixture();
  prepareFixture(tampered.input());
  privateFile(tampered.capacityReceipt, "tampered capacity receipt\n");
  const tamperedLaunchctl = new FakeLaunchctl();
  assert.throws(
    () => armFixture(tampered.launcherRoot, { launchctl: tamperedLaunchctl }),
    /shared-history-capacity-receipt-hmac-invalid/,
  );
  assert.equal(tamperedLaunchctl.calls.includes("bootstrap"), false, "tampered proof cannot create a LaunchAgent");
  assert.equal(existsSync(offlineMigrationLauncherPaths(tampered.launcherRoot).attempt), false);

  const rebound = new Fixture();
  prepareFixture(rebound.input());
  const contextPath = offlineMigrationLauncherPaths(rebound.launcherRoot).context;
  const raw = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, unknown>;
  (raw.migration as Record<string, unknown>).legacyDefinitionsRoot = rebound.sharedSkillsRoot;
  privateFile(contextPath, `${JSON.stringify(raw)}\n`);
  const reboundLaunchctl = new FakeLaunchctl();
  assert.throws(
    () => armFixture(rebound.launcherRoot, { launchctl: reboundLaunchctl }),
    /shared-history-capacity-receipt-changed-after-prepare/,
  );
  assert.equal(reboundLaunchctl.calls.includes("bootstrap"), false, "a source-root mismatch cannot arm launchd");
  assert.equal(existsSync(offlineMigrationLauncherPaths(rebound.launcherRoot).attempt), false);

  const malformed = new Fixture();
  prepareFixture(malformed.input());
  const malformedContextPath = offlineMigrationLauncherPaths(malformed.launcherRoot).context;
  const malformedRaw = JSON.parse(readFileSync(malformedContextPath, "utf8")) as Record<string, unknown>;
  delete ((malformedRaw.capacityReceipt as Record<string, unknown>).roots as Record<string, unknown>).definitions;
  privateFile(malformedContextPath, `${JSON.stringify(malformedRaw)}\n`);
  assert.throws(
    () => readOfflineMigrationLauncherContext(malformed.launcherRoot),
    /invalid-shared-history-capacity-receipt-binding/,
  );
});

test("the worker rechecks its sealed capacity receipt before waiting or recording an attempt", () => {
  const fixture = new Fixture();
  const context = prepareFixture(fixture.input());
  const launchctl = new FakeLaunchctl();
  armFixture(fixture.launcherRoot, { launchctl });
  privateFile(fixture.capacityReceipt, "tampered capacity receipt\n");
  let migrations = 0;
  const result = runManagerWorker(context, launchctl, {
    now: () => NOW,
    writerCensus: idleCensus,
    migrate: () => {
      migrations += 1;
      return publishMigratedFixture(context);
    },
  });
  assert.equal(result.state, "manual-recovery-required");
  assert.equal(result.reason, "shared-history-capacity-receipt-hmac-invalid");
  assert.equal(migrations, 0);
  assert.equal(existsSync(offlineMigrationLauncherPaths(fixture.launcherRoot).waiting), false);
  assert.equal(existsSync(offlineMigrationLauncherPaths(fixture.launcherRoot).attempt), false);
});

test("launcher preparation rejects symlinked or overlapping definitions roots before persisting context", () => {
  const fixture = new Fixture();
  const alias = join(fixture.root, "definitions-alias");
  symlinkSync(fixture.legacyDefinitionsRoot, alias);
  assert.throws(
    () => prepareFixture({ ...fixture.input(), migration: { ...fixture.input().migration, legacyDefinitionsRoot: alias } }),
    /legacy-definitions-root-symlink-refused/,
  );

  const overlap = new Fixture();
  assert.throws(
    () => prepareFixture({ ...overlap.input(), migration: { ...overlap.input().migration, legacyDefinitionsRoot: overlap.root } }),
    /global-v3-root-overlaps-legacy-input/,
  );
});

test("the one-shot runner performs two independent zero-writer censuses, commits its terminal result, then removes its plist and label", () => {
  const fixture = new Fixture();
  const context = prepareFixture(fixture.input(OTHER_TRANSACTION));
  const launchctl = new FakeLaunchctl();
  armFixture(fixture.launcherRoot, { launchctl });
  const events: string[] = [];
  let censuses = 0;
  let migrations = 0;
  let waitClock = 0;
  const result = runManagerWorker(context, launchctl, {
    now: () => NOW,
    waitNow: () => waitClock,
    wait: (milliseconds) => { waitClock += milliseconds; },
    waitPollIntervalMs: 1,
    writerCensus: () => {
      censuses += 1;
      return idleCensus();
    },
    migrate: (input) => {
      migrations += 1;
      assert.equal(input.apply, true);
      assert.equal(input.transactionId, OTHER_TRANSACTION);
      assert.equal(input.capacityReceiptPath, fixture.capacityReceipt);
      return publishMigratedFixture(context);
    },
    inspectRollback: () => v3Rollback(),
    onEvent: (event) => {
      if (event.event === "terminal-result-committed" || event.event === "plist-removed") {
        assert.equal(
          existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_TERMINAL_RESULT_FILE)),
          true,
          "the terminal sentinel must exist before self-removal begins",
        );
      }
      events.push(event.event);
    },
  });

  assert.equal(result.state, "migrated");
  assert.equal(censuses, 2);
  assert.equal(migrations, 1);
  assert.equal(existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_TERMINAL_RESULT_FILE)), true);
  assert.equal(
    lstatSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_TERMINAL_RESULT_FILE)).mode & 0o7777,
    0o600,
  );
  assert.equal(existsSync(context.plistPath), false);
  assert.equal(launchctl.labels.size, 0);
  assert.ok(events.indexOf("terminal-result-committed") < events.indexOf("plist-removed"));
  assert.ok(events.indexOf("plist-removed") < events.indexOf("launchd-bootout"));
  assert.ok(events.indexOf("launchd-bootout") < events.indexOf("self-removal-verified"));
  assert.equal(inspectOfflineMigrationLauncher(fixture.launcherRoot, { launchctl }).state, "terminal");
});

test("a failed bootstrap durably records the terminal result before verified self-removal", () => {
  const fixture = new Fixture();
  prepareFixture(fixture.input());
  const launchctl = new BootstrapFailureLaunchctl();
  assert.throws(
    () => armFixture(fixture.launcherRoot, { launchctl, now: () => NOW }),
    /launchd-bootstrap-failed/,
  );
  const inspection = inspectOfflineMigrationLauncher(fixture.launcherRoot, { launchctl });
  assert.equal(inspection.state, "terminal");
  assert.equal(inspection.terminalResult?.state, "arm-failed");
  assert.equal(inspection.plistPresent, false);
  assert.equal(inspection.launchdLoaded, false);
  assert.equal(launchctl.labels.size, 0);
  assert.ok(launchctl.calls.includes("bootout"));
});

test("sealed manager generation, inventories, and the exact current independent Tweakers promotion receipt must not drift before arm", () => {
  const fixture = new Fixture();
  prepareFixture(fixture.input());
  privateFile(fixture.additionalInventory, '{"version":1,"skills":["drift"]}\n');
  const launchctl = new FakeLaunchctl();
  assert.throws(
    () => armFixture(fixture.launcherRoot, { launchctl }),
    /sealed-inventory-changed-after-prepare/,
  );
  assert.equal(launchctl.calls.includes("bootstrap"), false);

  const second = new Fixture();
  prepareFixture(second.input());
  chmodSync(second.managerBundle, 0o600);
  privateFile(second.managerBundle, "changed manager bundle\n", 0o400);
  assert.throws(
    () => armFixture(second.launcherRoot, { launchctl: new FakeLaunchctl() }),
    /manager-generation-(?:target-seal-mismatch|changed-after-prepare)/,
  );

  const promotion = new Fixture();
  prepareFixture(promotion.input());
  promotion.writePromotionReceipt({ operationId: "independent-operation-drift" });
  assert.throws(
    () => armFixture(promotion.launcherRoot, { launchctl: new FakeLaunchctl() }),
    /tweakers-promotion-fingerprint-mismatch/,
  );
});

test("only the exact v5 runtime-ready receipt with normalized appearance, all 11 required tweaks, and an absent pre-migration broker can be sealed", () => {
  const legacy = new Fixture();
  legacy.writePromotionReceipt({ schemaVersion: 3 });
  assert.throws(
    () => prepareFixture(legacy.input()),
    /invalid-tweakers-promotion-binding/,
  );

  const inconsistentAuthority = new Fixture();
  inconsistentAuthority.writePromotionReceipt({
    brokerAuthorityExpectation: { globalRootState: "valid-v3", configSha256: "e".repeat(64) },
    sharedHistoryBrokerState: "connected",
  });
  assert.throws(
    () => prepareFixture(inconsistentAuthority.input()),
    /invalid-tweakers-promotion-binding/,
  );

  const missingRequiredTweak = new Fixture();
  missingRequiredTweak.writePromotionReceipt({
    initializedTweakIds: [...REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS].slice(0, -1),
  });
  assert.throws(
    () => prepareFixture(missingRequiredTweak.input()),
    /invalid-tweakers-promotion-binding/,
  );

  const wrongBrokerRoot = new Fixture();
  wrongBrokerRoot.writePromotionReceipt({ accountsBrokerRoot: join(wrongBrokerRoot.root, "different-global-root") });
  assert.throws(
    () => prepareFixture(wrongBrokerRoot.input()),
    /invalid-tweakers-promotion-binding/,
  );

  const connectedBeforeMigration = new Fixture();
  connectedBeforeMigration.writePromotionReceipt({ sharedHistoryBrokerState: "connected" });
  assert.throws(
    () => prepareFixture(connectedBeforeMigration.input()),
    /invalid-tweakers-promotion-binding/,
  );

  const absentAppearance = new Fixture();
  absentAppearance.writePromotionReceipt({ appearance: undefined });
  assert.throws(
    () => prepareFixture(absentAppearance.input()),
    /invalid-tweakers-promotion-binding/,
  );

  const nonNormalAppearance = new Fixture();
  nonNormalAppearance.writePromotionReceipt({ appearance: { status: "needs_attention", normalized: false } });
  assert.throws(
    () => prepareFixture(nonNormalAppearance.input()),
    /invalid-tweakers-promotion-binding/,
  );
});

test("prepare requires a fresh, live, exact Tweakers runtime-ready receipt", () => {
  const cases: readonly {
    name: string;
    receipt?: Record<string, unknown>;
    code: string;
    probe?: (input: OfflineMigrationTweakersRuntimeReadyProbeInput) => OfflineMigrationTweakersRuntimeReadyProbeResult;
  }[] = [
    {
      name: "stale receipt",
      receipt: { observedAt: "2026-09-04T11:54:59.999Z" },
      code: "tweakers-runtime-ready-receipt-stale",
    },
    {
      name: "missing process",
      code: "tweakers-runtime-ready-process-not-current",
      probe: (input) => ({ ...fixtureRuntimeReadyProbe(input), process: null }),
    },
    {
      name: "different process start token",
      code: "tweakers-runtime-ready-process-start-token-mismatch",
      probe: (input) => {
        const current = fixtureRuntimeReadyProbe(input);
        return {
          ...current,
          process: current.process === null ? null : { ...current.process, processStartToken: "other-process-start-token" },
        };
      },
    },
    {
      name: "different main command",
      code: "tweakers-runtime-ready-main-command-mismatch",
      probe: (input) => {
        const current = fixtureRuntimeReadyProbe(input);
        return {
          ...current,
          process: current.process === null ? null : { ...current.process, command: join(input.appRoot, "Contents", "MacOS", "Helper") },
        };
      },
    },
    {
      name: "different user-data argument",
      code: "tweakers-runtime-ready-main-command-mismatch",
      probe: (input) => {
        const current = fixtureRuntimeReadyProbe(input);
        return {
          ...current,
          process: current.process === null ? null : {
            ...current.process,
            command: `${join(input.appRoot, "Contents", "MacOS", TWEAKERS_ORIGINAL_EXECUTABLE)} --user-data-dir=${join(TEMPORARY_ROOT, "other-user-data")}`,
          },
        };
      },
    },
    {
      name: "additional main-process argument",
      code: "tweakers-runtime-ready-main-command-mismatch",
      probe: (input) => {
        const current = fixtureRuntimeReadyProbe(input);
        return {
          ...current,
          process: current.process === null ? null : {
            ...current.process,
            command: `${current.process.command} --inspect=9229`,
          },
        };
      },
    },
    {
      name: "different app asar identity",
      code: "tweakers-runtime-ready-asar-fingerprint-mismatch",
      probe: (input) => ({ ...fixtureRuntimeReadyProbe(input), appAsarHeaderHash: "e".repeat(64) }),
    },
    {
      name: "different runtime identity",
      code: "tweakers-runtime-ready-runtime-fingerprint-mismatch",
      probe: (input) => ({ ...fixtureRuntimeReadyProbe(input), runtimeFingerprint: "f".repeat(64) }),
    },
  ];
  for (const scenario of cases) {
    const fixture = new Fixture();
    fixture.writePromotionReceipt(scenario.receipt);
    assert.throws(
      () => prepareOfflineMigrationLauncher(fixture.input(), {
        now: () => NOW,
        runtimeReadyProbe: scenario.probe ?? fixtureRuntimeReadyProbe,
        inspectCapacityReceipt: fixtureCapacityReceiptInspector,
      }),
      new RegExp(scenario.code),
      scenario.name,
    );
  }
});

test("active writers wait for a deliberate zero-writer window before the attempt latch and apply", () => {
  const fixture = new Fixture();
  const context = prepareFixture(fixture.input());
  const launchctl = new FakeLaunchctl();
  armFixture(fixture.launcherRoot, { launchctl });
  let censuses = 0;
  let migrations = 0;
  let waitClock = 0;
  const dependencies = {
    now: () => NOW,
    waitNow: () => waitClock,
    wait: (milliseconds: number) => { waitClock += milliseconds; },
    waitPollIntervalMs: 1,
    writerCensus: () => {
      censuses += 1;
      if (censuses === 1) {
        assert.equal(existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_ATTEMPT_FILE)), false);
        return { ...idleCensus(), chatgptWriters: 1, tweakersWriters: 1 };
      }
      return idleCensus();
    },
    migrate: () => {
      migrations += 1;
      return publishMigratedFixture(context);
    },
    inspectRollback: () => v3Rollback(),
  };
  const migrated = runManagerWorker(context, launchctl, dependencies);
  assert.equal(migrated.state, "migrated");
  assert.equal(censuses, 3, "one active and two spaced zero-writer observations");
  assert.equal(migrations, 1);
  assert.equal(existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_WAITING_FILE)), true);
  assert.equal(existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_ATTEMPT_FILE)), true);
});

test("a bounded never-zero wait blocks once without an attempt or automatic retry", () => {
  const fixture = new Fixture();
  const context = prepareFixture(fixture.input());
  const launchctl = new FakeLaunchctl();
  armFixture(fixture.launcherRoot, { launchctl });
  let censuses = 0;
  let migrations = 0;
  let waitClock = 0;
  const dependencies = {
    now: () => NOW,
    waitNow: () => waitClock,
    wait: (milliseconds: number) => { waitClock += milliseconds; },
    waitTimeoutMs: 3,
    waitPollIntervalMs: 1,
    writerCensus: () => {
      censuses += 1;
      return { ...idleCensus(), brokerWriters: 1 };
    },
    migrate: () => {
      migrations += 1;
      return migratedResult(APPROVED_TRANSACTION);
    },
  };
  const blocked = runManagerWorker(context, launchctl, dependencies);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.reason, "zero-writer-window-timeout");
  assert.equal(censuses > 1, true);
  assert.equal(migrations, 0);
  assert.equal(existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_ATTEMPT_FILE)), false);
  const censusesAtTerminal = censuses;
  const repeated = runManagerWorker(context, launchctl, dependencies);
  assert.equal(repeated.state, "blocked");
  assert.equal(censuses, censusesAtTerminal, "a durable terminal sentinel must not recensus or retry");
  assert.equal(migrations, 0);
});

test("an interrupted waiting state, attempt, migration journal, or v3 root is a manual-recovery stop before apply", () => {
  for (const kind of ["waiting", "attempt", "journal", "global-root"] as const) {
    const fixture = new Fixture();
    const context = prepareFixture(fixture.input(kind === "journal" ? APPROVED_TRANSACTION : OTHER_TRANSACTION));
    const launchctl = new FakeLaunchctl();
    armFixture(fixture.launcherRoot, { launchctl });
    if (kind === "waiting") privateFile(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_WAITING_FILE), "{}\n");
    else if (kind === "attempt") privateFile(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_ATTEMPT_FILE), "{}\n");
    else if (kind === "journal") privateFile(context.migrationJournalPath, "{}\n");
    else privateDirectory(fixture.globalRoot);
    let migrations = 0;
    const result = runManagerWorker(context, launchctl, {
      now: () => NOW,
      writerCensus: idleCensus,
      migrate: () => {
        migrations += 1;
        return migratedResult(context.transactionId, context.migration.sharedSkillsRoots);
      },
    });
    assert.equal(result.state, "manual-recovery-required", kind);
    assert.equal(migrations, 0, kind);
    assert.match(
      result.reason ?? "",
      kind === "waiting"
        ? /interrupted-wait-requires-manual-recovery/
        : kind === "attempt"
          ? /interrupted-attempt-requires-manual-recovery/
        : kind === "journal"
          ? /journal-already-exists/
          : /global-v3-root-already-exists/,
    );
  }
});

test("a published v3 root whose rollback view is not v3-safe is retained for manual recovery and never reverted", () => {
  const fixture = new Fixture();
  const context = prepareFixture(fixture.input());
  const launchctl = new FakeLaunchctl();
  armFixture(fixture.launcherRoot, { launchctl });
  let migrations = 0;
  const result = runManagerWorker(context, launchctl, {
    now: () => NOW,
    waitNow: () => 0,
    wait: () => undefined,
    waitPollIntervalMs: 1,
    writerCensus: idleCensus,
    migrate: () => {
      migrations += 1;
      return publishMigratedFixture(context);
    },
    inspectRollback: () => ({ ...v3Rollback(), legacySqliteFlattened: true }),
  });
  assert.equal(migrations, 1);
  assert.equal(result.state, "manual-recovery-required");
  assert.equal(result.phase, "rollback-verification");
  assert.equal(existsSync(fixture.globalRoot), true, "the launcher retains v3 evidence; it never restores a v2-incompatible layout");
});

test("the generated plist manager argv is the exact positive internal worker contract", () => {
  const fixture = new Fixture();
  const context = prepareFixture(fixture.input());
  const launchctl = new FakeLaunchctl();
  armFixture(fixture.launcherRoot, { launchctl });
  let waitClock = 0;
  const result = runManagerWorker(context, launchctl, {
    now: () => NOW,
    waitNow: () => waitClock,
    wait: (milliseconds) => { waitClock += milliseconds; },
    waitPollIntervalMs: 1,
    writerCensus: idleCensus,
    migrate: () => publishMigratedFixture(context),
    inspectRollback: () => v3Rollback(),
  });
  assert.equal(result.state, "migrated");
  assert.equal(existsSync(context.plistPath), false);
  assert.equal(launchctl.labels.size, 0);
});

test("an exited loaded KeepAlive=false worker is interrupted both before and after its waiting marker", () => {
  for (const waitingPresent of [false, true]) {
    const fixture = new Fixture();
    const context = prepareFixture(fixture.input());
    const launchctl = new FakeLaunchctl();
    armFixture(fixture.launcherRoot, { launchctl });
    if (waitingPresent) privateFile(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_WAITING_FILE), "{}\n");
    const service = `gui/${process.getuid?.()}/${context.label}`;
    launchctl.setWorkerState(service, "exited");

    const inspection = inspectOfflineMigrationLauncher(fixture.launcherRoot, {
      launchctl,
      isProcessAlive: () => true,
    });
    assert.equal(inspection.launchdLoaded, true);
    assert.equal(inspection.workerPid, process.pid);
    assert.equal(inspection.workerLive, false);
    assert.equal(inspection.state, "interrupted", waitingPresent ? "after waiting marker" : "before waiting marker");
  }
});

test("inspection retains prepared and live armed states but fails closed for dead or ambiguous loaded service prints", () => {
  const preparedFixture = new Fixture();
  const preparedLaunchctl = new FakeLaunchctl();
  prepareFixture(preparedFixture.input());
  assert.equal(inspectOfflineMigrationLauncher(preparedFixture.launcherRoot, { launchctl: preparedLaunchctl }).state, "prepared");

  const scenarios: readonly {
    name: string;
    configure: (launchctl: FakeLaunchctl, service: string) => void;
    isProcessAlive?: (pid: number) => boolean;
  }[] = [
    {
      name: "dead running pid",
      configure: () => undefined,
      isProcessAlive: () => false,
    },
    {
      name: "malformed successful print",
      configure: (launchctl, service) => launchctl.setPrintOverride(service, "not a launchctl service record\n"),
    },
    {
      name: "indeterminate null status",
      configure: (launchctl, service) => launchctl.setPrintResult(service, { status: null, error: "fixture-spawn-error" }),
    },
    {
      name: "indeterminate non-not-found status",
      configure: (launchctl, service) => launchctl.setPrintResult(service, { status: 1, error: "fixture-permission-error" }),
    },
  ];

  for (const scenario of scenarios) {
    const fixture = new Fixture();
    const context = prepareFixture(fixture.input());
    const launchctl = new FakeLaunchctl();
    assert.equal(armFixture(fixture.launcherRoot, { launchctl }).state, "armed");
    const service = `gui/${process.getuid?.()}/${context.label}`;
    scenario.configure(launchctl, service);
    const inspection = inspectOfflineMigrationLauncher(fixture.launcherRoot, {
      launchctl,
      isProcessAlive: scenario.isProcessAlive,
    });
    assert.equal(inspection.state, "interrupted", scenario.name);
  }
});

test("inspection treats an orphan plist or a live job missing its plist as interrupted", () => {
  const orphanFixture = new Fixture();
  const orphanContext = prepareFixture(orphanFixture.input());
  const orphanLaunchctl = new FakeLaunchctl();
  // Simulates a process interruption after the private plist write but before
  // launchctl bootstrap. The fake service definitively reports status 113.
  privateFile(orphanContext.plistPath, "<plist version=\"1.0\"/>\n");
  const orphanInspection = inspectOfflineMigrationLauncher(orphanFixture.launcherRoot, { launchctl: orphanLaunchctl });
  assert.equal(orphanInspection.launchdLoaded, false);
  assert.equal(orphanInspection.plistPresent, true);
  assert.equal(orphanInspection.state, "interrupted");

  const missingPlistFixture = new Fixture();
  const missingPlistContext = prepareFixture(missingPlistFixture.input());
  const missingPlistLaunchctl = new FakeLaunchctl();
  assert.equal(armFixture(missingPlistFixture.launcherRoot, { launchctl: missingPlistLaunchctl }).state, "armed");
  // This test-only temporary-file deletion models an interrupted external
  // removal. The launchd job remains live, but it no longer has its exact
  // private plist counterpart and must not be called armed.
  unlinkSync(missingPlistContext.plistPath);
  const missingPlistInspection = inspectOfflineMigrationLauncher(missingPlistFixture.launcherRoot, {
    launchctl: missingPlistLaunchctl,
    isProcessAlive: () => true,
  });
  assert.equal(missingPlistInspection.launchdLoaded, true);
  assert.equal(missingPlistInspection.plistPresent, false);
  assert.equal(missingPlistInspection.workerLive, true);
  assert.equal(missingPlistInspection.state, "interrupted");
});

test("the fixed manager capability rejects a context edited after arm before it can consume the transaction", () => {
  const fixture = new Fixture();
  const context = prepareFixture(fixture.input());
  const launchctl = new FakeLaunchctl();
  armFixture(fixture.launcherRoot, { launchctl });
  const originalArgv = managerRunArguments(context);
  const contextPath = offlineMigrationLauncherPaths(context.launcherRoot).context;
  privateFile(contextPath, `${readFileSync(contextPath, "utf8").trimEnd()}\n\n`);
  let migrations = 0;

  assert.throws(
    () => runManagerWorker(context, launchctl, {
      migrate: () => {
        migrations += 1;
        return publishMigratedFixture(context);
      },
    }, originalArgv),
    /internal-manager-context-capability-mismatch/,
  );
  assert.equal(migrations, 0);
  assert.equal(existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_ATTEMPT_FILE)), false);
  assert.equal(existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_TERMINAL_RESULT_FILE)), false);
  assert.equal(existsSync(context.plistPath), true);
});

test("launchd-origin proof uses actual print grammar and rejects route, parent, duplicate, and nested-lookalike ambiguity", () => {
  const cases: readonly {
    name: string;
    expected: RegExp;
    configure: (
      context: OfflineMigrationLauncherContextV1,
      launchctl: FakeLaunchctl,
      service: string,
      dependencies: OfflineMigrationLauncherDependencies,
    ) => void;
  }[] = [
    {
      name: "different sealed Node route",
      expected: /internal-manager-execution-route-mismatch/,
      configure: (context, _launchctl, _service, dependencies) => {
        const route = dependencies.currentExecutionRoute?.();
        assert.ok(route);
        dependencies.currentExecutionRoute = () => ({ ...route, nodePath: `${context.executor.node.path}.other` });
      },
    },
    {
      name: "not launchd-parented",
      expected: /internal-manager-execution-route-mismatch/,
      configure: (_context, _launchctl, _service, dependencies) => {
        dependencies.currentParentProcessId = () => 99;
      },
    },
    {
      name: "duplicate top-level state",
      expected: /internal-manager-launchd-service-binding-mismatch/,
      configure: (_context, launchctl, service) => {
        const output = launchctl.print(service).output ?? "";
        launchctl.setPrintOverride(service, output.replace("\tstate = running", "\tstate = running\n\tstate = running"));
      },
    },
    {
      name: "duplicate top-level arguments block",
      expected: /internal-manager-launchd-service-binding-mismatch/,
      configure: (_context, launchctl, service) => {
        const output = launchctl.print(service).output ?? "";
        launchctl.setPrintOverride(service, output.replace(
          `\tpid = ${process.pid}`,
          `\targuments = {\n\t\tduplicate\n\t}\n\tpid = ${process.pid}`,
        ));
      },
    },
    {
      name: "nested lookalike fields without top-level identity",
      expected: /internal-manager-launchd-service-binding-mismatch/,
      configure: (context, launchctl, service) => {
        launchctl.setPrintOverride(service, [
          `${service} = {`,
          `\tpath = ${context.plistPath}`,
          `\tprogram = ${context.executor.node.path}`,
          "\tenvironment = {",
          "\t\tstate = running",
          `\t\tpid = ${process.pid}`,
          "\t}",
          "}",
          "",
        ].join("\n"));
      },
    },
    {
      name: "malformed parenthesized scalar key",
      expected: /internal-manager-launchd-service-binding-mismatch/,
      configure: (_context, launchctl, service) => {
        const output = launchctl.print(service).output ?? "";
        launchctl.setPrintOverride(service, output.replace(
          "\tjetsam memory limit (active) = (unlimited)",
          "\tjetsam memory limit (ACTIVE) = (unlimited)",
        ));
      },
    },
  ];

  for (const scenario of cases) {
    const fixture = new Fixture();
    const context = prepareFixture(fixture.input());
    const launchctl = new FakeLaunchctl();
    armFixture(fixture.launcherRoot, { launchctl });
    const service = `gui/${process.getuid?.()}/${context.label}`;
    const argv = managerRunArguments(context);
    const dependencies = managerRunnerDependencies(context, launchctl, {
      migrate: () => assert.fail("origin proof must precede migration") as never,
    }, argv);
    const normalPrint = launchctl.print(service).output ?? "";
    assert.match(
      normalPrint,
      /^\S+ = \{\n\tpath = .+\n\ttype = LaunchAgent\n\tstate = running\n\tjetsam memory limit \(active\) = \(unlimited\)\n\tjetsam memory limit \(inactive\) = \(unlimited\)\n\tmanaged_by = launchd\n\n\tprogram = .+\n\targuments = \{(?:\n\t\t.+)+\n\t\}/,
      "the fixture uses launchctl print's observed top-level and arguments grammar",
    );
    scenario.configure(context, launchctl, service, dependencies);
    assert.throws(
      () => runOfflineMigrationLauncherManagerCommand(argv, dependencies),
      scenario.expected,
      scenario.name,
    );
    assert.equal(existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_ATTEMPT_FILE)), false, scenario.name);
    assert.equal(existsSync(join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_TERMINAL_RESULT_FILE)), false, scenario.name);
    const inspection = inspectOfflineMigrationLauncher(fixture.launcherRoot, { launchctl });
    assert.deepEqual(
      Object.keys(inspection.originProofDiagnostic ?? {}).sort(),
      ["kind", "phase", "reason", "recordedAt", "transactionId", "version"],
      scenario.name,
    );
    assert.equal(inspection.originProofDiagnostic?.transactionId, context.transactionId, scenario.name);
    assert.equal(inspection.originProofDiagnostic?.phase, "origin-proof", scenario.name);
    assert.equal(inspection.waitingPresent, false, scenario.name);
    assert.equal(inspection.attemptPresent, false, scenario.name);
    assert.equal(inspection.migrationJournalPresent, false, scenario.name);
    assert.equal(inspection.globalRootPresent, false, scenario.name);
    assert.equal(inspection.terminalResult, null, scenario.name);
  }
});

test("origin-proof diagnostics are first-failure evidence and never become migration state", () => {
  const fixture = new Fixture();
  const context = prepareFixture(fixture.input());
  const launchctl = new FakeLaunchctl();
  armFixture(fixture.launcherRoot, { launchctl });
  const dependencies = managerRunnerDependencies(context, launchctl, { now: () => NOW });
  dependencies.currentParentProcessId = () => 99;
  const argv = managerRunArguments(context);

  assert.throws(
    () => runOfflineMigrationLauncherManagerCommand(argv, dependencies),
    /internal-manager-execution-route-mismatch/,
  );
  const diagnosticPath = offlineMigrationLauncherPaths(fixture.launcherRoot).originProofDiagnostic;
  const firstDiagnostic = readFileSync(diagnosticPath);
  assert.throws(
    () => runOfflineMigrationLauncherManagerCommand(argv, dependencies),
    /internal-manager-execution-route-mismatch/,
  );
  assert.deepEqual(readFileSync(diagnosticPath), firstDiagnostic);

  const inspection = inspectOfflineMigrationLauncher(fixture.launcherRoot, { launchctl });
  assert.equal(inspection.state, "armed");
  assert.equal(inspection.originProofDiagnostic?.reason, "internal-manager-execution-route-mismatch");
  assert.equal(inspection.waitingPresent, false);
  assert.equal(inspection.attemptPresent, false);
  assert.equal(inspection.migrationJournalPresent, false);
  assert.equal(inspection.globalRootPresent, false);
  assert.equal(inspection.terminalResult, null);
});

test("inspection rejects forged migrated terminal results, rollback bindings, and journal evidence", () => {
  const mutateJournal = (fixture: Fixture, mutate: (journal: Record<string, unknown>) => void): void => {
    const context = readOfflineMigrationLauncherContext(fixture.launcherRoot);
    const journal = JSON.parse(readFileSync(context.migrationJournalPath, "utf8")) as Record<string, unknown>;
    mutate(journal);
    privateFile(context.migrationJournalPath, `${JSON.stringify(journal)}\n`);
  };
  const mutations: readonly {
    name: string;
    mutate: (terminal: Record<string, unknown>, fixture: Fixture) => void;
    expected: RegExp;
  }[] = [
    {
      name: "migrated result next action",
      mutate: (terminal) => {
        (terminal.migrationResult as Record<string, unknown>).nextAction = "none";
      },
      expected: /migrated-terminal-evidence-invalid/,
    },
    {
      name: "rollback canonical fingerprint",
      mutate: (terminal) => {
        (terminal.rollback as Record<string, unknown>).canonicalFingerprint = `sha256:${"b".repeat(64)}`;
      },
      expected: /migrated-terminal-journal-binding-invalid/,
    },
    {
      name: "migrated phase/reason correlation",
      mutate: (terminal) => {
        terminal.reason = "forged-success-reason";
      },
      expected: /invalid-terminal-result/,
    },
    {
      name: "published journal canonical count",
      mutate: (_terminal, fixture) => mutateJournal(fixture, (journal) => {
        (journal.canonical as Record<string, unknown>).conversationCount = 2;
      }),
      expected: /migrated-terminal-journal-binding-invalid/,
    },
    {
      name: "pre-adoption manifest extra field",
      mutate: (_terminal, fixture) => mutateJournal(fixture, (journal) => {
        (journal.preAdoptionManifest as Record<string, unknown>).unexpected = true;
      }),
      expected: /migrated-terminal-journal-binding-invalid/,
    },
    {
      name: "pre-migration manifest malformed nested file",
      mutate: (_terminal, fixture) => mutateJournal(fixture, (journal) => {
        (journal.preMigrationManifest as Record<string, unknown>).files = [{ path: "unsafe", bytes: -1, sha256: SHA }];
      }),
      expected: /migrated-terminal-journal-binding-invalid/,
    },
    {
      name: "candidate manifest malformed nested link",
      mutate: (_terminal, fixture) => mutateJournal(fixture, (journal) => {
        (journal.candidateManifest as Record<string, unknown>).links = [{ path: "cache", target: "../../wrong" }];
      }),
      expected: /migrated-terminal-journal-binding-invalid/,
    },
    {
      name: "shared Skills manifest extra field",
      mutate: (_terminal, fixture) => mutateJournal(fixture, (journal) => {
        (journal.sharedSkills as Record<string, unknown>).unexpected = true;
      }),
      expected: /migrated-terminal-journal-binding-invalid/,
    },
    {
      name: "shared Plugins manifest malformed nested package",
      mutate: (_terminal, fixture) => mutateJournal(fixture, (journal) => {
        ((journal.sharedPlugins as Record<string, unknown>).packages as unknown[])![0] = { pluginId: FIXTURE_PLUGIN.pluginId };
      }),
      expected: /migrated-terminal-journal-binding-invalid/,
    },
    {
      name: "shared Skills trusted roots must bind current source identity",
      mutate: (_terminal, fixture) => mutateJournal(fixture, (journal) => {
        const sharedSkills = journal.sharedSkills as Record<string, unknown>;
        const trustedRoots = sharedSkills.trustedRoots as Record<string, unknown>[];
        trustedRoots[0]!.inode = Number(trustedRoots[0]!.inode) + 1;
        sharedSkills.trustedRootsFingerprint = canonicalSha256Fingerprint(trustedRoots);
        sharedSkills.fingerprint = canonicalSha256Fingerprint({
          directories: sharedSkills.directories,
          files: sharedSkills.files,
          trustedRoots,
          trustedRootsFingerprint: sharedSkills.trustedRootsFingerprint,
        });
      }),
      expected: /migrated-terminal-journal-binding-invalid/,
    },
    {
      name: "shared Plugins packages must bind inventory and migration result",
      mutate: (_terminal, fixture) => mutateJournal(fixture, (journal) => {
        const sharedPlugins = journal.sharedPlugins as Record<string, unknown>;
        const packages = sharedPlugins.packages as Record<string, unknown>[];
        packages[0]!.version = "2.0.0";
        sharedPlugins.fingerprint = canonicalSha256Fingerprint({
          inventoryFingerprint: sharedPlugins.inventoryFingerprint,
          exclusionsFingerprint: sharedPlugins.exclusionsFingerprint,
          packages,
        });
      }),
      expected: /migrated-terminal-journal-binding-invalid/,
    },
  ];

  for (const scenario of mutations) {
    const fixture = new Fixture();
    const context = prepareFixture(fixture.input());
    const launchctl = new FakeLaunchctl();
    armFixture(fixture.launcherRoot, { launchctl });
    const result = runManagerWorker(context, launchctl, {
      now: () => NOW,
      waitNow: () => 0,
      wait: () => undefined,
      waitPollIntervalMs: 1,
      writerCensus: idleCensus,
      migrate: () => publishMigratedFixture(context),
      inspectRollback: () => v3Rollback(),
    });
    assert.equal(result.state, "migrated");
    const terminalPath = join(fixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_TERMINAL_RESULT_FILE);
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8")) as Record<string, unknown>;
    scenario.mutate(terminal, fixture);
    privateFile(terminalPath, `${JSON.stringify(terminal)}\n`);
    assert.throws(
      () => inspectOfflineMigrationLauncher(fixture.launcherRoot, { launchctl }),
      scenario.expected,
      scenario.name,
    );
  }
});

test("symlinked identity inputs are rejected and the CLI only accepts explicit launcher actions", () => {
  const fixture = new Fixture();
  const target = join(fixture.root, "inventory-target.json");
  privateFile(target, "{}\n");
  const alias = join(fixture.root, "inventory-alias.json");
  symlinkSync(target, alias);
  assert.throws(
    () => prepareFixture({ ...fixture.input(), sealedInventoryPaths: [alias] }),
    /symlink-refused/,
  );

  const cliFixture = new Fixture();
  const printed: string[] = [];
  const prepared = offlineMigrationLauncherCommand("prepare", cliOptions(cliFixture), {
    now: () => NOW,
    runtimeReadyProbe: fixtureRuntimeReadyProbe,
    inspectCapacityReceipt: fixtureCapacityReceiptInspector,
    print: (line) => printed.push(line),
  });
  assert.equal(prepared.transactionId, APPROVED_TRANSACTION);
  assert.equal(prepared.migration.legacyDefinitionsRoot, cliFixture.legacyCodexRoot);
  assert.equal(prepared.migration.capacityReceiptPath, cliFixture.capacityReceipt);
  assert.equal(printed.length, 1);
  const explicitCliFixture = new Fixture();
  const explicitPrepared = offlineMigrationLauncherCommand("prepare", {
    ...cliOptions(explicitCliFixture),
    "legacy-definitions-root": explicitCliFixture.legacyDefinitionsRoot,
  }, {
    now: () => NOW,
    runtimeReadyProbe: fixtureRuntimeReadyProbe,
    inspectCapacityReceipt: fixtureCapacityReceiptInspector,
  });
  assert.equal(explicitPrepared.migration.legacyDefinitionsRoot, explicitCliFixture.legacyDefinitionsRoot);
  assert.throws(
    () => offlineMigrationLauncherCommand("unexpected", { "launcher-root": cliFixture.launcherRoot }),
    /must be prepare, inspect, or arm/,
  );
  const priorLaunchd = process.env.TWEAKERS_OFFLINE_MIGRATION_LAUNCHD;
  const priorExecutor = process.env.TWEAKERS_OFFLINE_MIGRATION_EXECUTOR;
  try {
    process.env.TWEAKERS_OFFLINE_MIGRATION_LAUNCHD = "spoofed";
    process.env.TWEAKERS_OFFLINE_MIGRATION_EXECUTOR = "/spoofed";
    assert.throws(
      () => offlineMigrationLauncherCommand("run", { "launcher-root": cliFixture.launcherRoot }),
      /run is manager-internal only/,
    );
  } finally {
    if (priorLaunchd === undefined) delete process.env.TWEAKERS_OFFLINE_MIGRATION_LAUNCHD;
    else process.env.TWEAKERS_OFFLINE_MIGRATION_LAUNCHD = priorLaunchd;
    if (priorExecutor === undefined) delete process.env.TWEAKERS_OFFLINE_MIGRATION_EXECUTOR;
    else process.env.TWEAKERS_OFFLINE_MIGRATION_EXECUTOR = priorExecutor;
  }
  assert.equal(
    existsSync(join(cliFixture.launcherRoot, OFFLINE_MIGRATION_LAUNCHER_TERMINAL_RESULT_FILE)),
    false,
    "an external CLI run attempt must not consume the transaction",
  );
});

function cliOptions(fixture: Fixture) {
  const input = fixture.input();
  return {
    transaction: input.transactionId,
    "launcher-root": input.launcherRoot,
    "launch-agents-root": input.launchAgentsRoot,
    "manager-generation-root": input.managerGeneration.generationRoot,
    "legacy-router-root": input.migration.legacyRouterRoot,
    "legacy-codex-root": input.migration.legacyCodexRoot,
    "legacy-sqlite-root": input.migration.legacySqliteRoot,
    "global-root": input.migration.globalRoot,
    app: input.migration.appPath,
    "tweakers-app": input.migration.tweakersAppPath,
    "shared-skills-root": input.migration.sharedSkillsRoots,
    "shared-plugin-inventory": input.migration.sharedPluginInventory,
    capacityReceipt: input.migration.capacityReceiptPath,
    "sealed-inventory": input.sealedInventoryPaths,
    "tweakers-promotion-receipt": input.tweakersPromotionReceipt,
    "tweakers-promotion-fingerprint": input.tweakersPromotionFingerprint,
  };
}

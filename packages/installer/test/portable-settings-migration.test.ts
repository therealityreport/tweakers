import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectPortableSettingsMigration,
  migratePortableSettings,
  portableSettingsMigrationPaths,
  recoverPortableSettingsMigration,
  type PortableSettingsMigrationDependencies,
  type PortableSettingsMigrationInput,
  type PortableSettingsWriterCensus,
} from "../src/portable-settings-migration.ts";
import { CANONICAL_HISTORY_FILE } from "../src/shared-history-migration.ts";

const NOW = "2026-09-04T12:00:00.000Z";
const ACCOUNT = `ar_${"a".repeat(43)}`;
const PUBLIC_THREAD = `lh_${"p".repeat(32)}`;
const CONVERSATION = `lc_${"c".repeat(32)}`;
const SEGMENT = `ls_${"s".repeat(32)}`;
const NATIVE_THREAD = "native-thread-alpha";
const PROJECTS_TWEAK = "co.tweakers.projects";
const USAGE_TWEAK = "usage-limit-resets-tracker";

interface Fixture {
  root: string;
  input: PortableSettingsMigrationInput;
  sourceGlobalState: string;
  targetGlobalState: string;
  sourceProjects: string;
  targetProjects: string;
  sourceConfig: string;
  targetConfig: string;
  dependencies: PortableSettingsMigrationDependencies;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function privateJson(path: string, value: unknown): void {
  privateDirectory(join(path, ".."));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function idleCensus(): PortableSettingsWriterCensus {
  return {
    observedAt: NOW,
    chatgpt: "idle",
    tweakers: "idle",
    appServers: "idle",
    openFileCount: 0,
  };
}

function fixture(transactionId = "portable-settings-test-a"): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tweakers-portable-settings-")));
  chmodSync(root, 0o700);
  const sourceCodexHomeRoot = join(root, "source-codex-home");
  const sourceTweakersRoot = join(root, "source-tweakers");
  const targetTweakersRoot = join(root, "target-tweakers");
  const targetCodexHomeRoot = join(targetTweakersRoot, "codex-home");
  const globalRoot = join(root, "global-v3");
  const chatgptAppPath = join(root, "ChatGPT.app");
  const tweakersAppPath = join(root, "Tweakers.app");
  for (const path of [
    sourceCodexHomeRoot,
    sourceTweakersRoot,
    targetTweakersRoot,
    targetCodexHomeRoot,
    globalRoot,
    chatgptAppPath,
    tweakersAppPath,
    join(sourceTweakersRoot, "tweak-data", PROJECTS_TWEAK),
    join(targetTweakersRoot, "tweak-data", PROJECTS_TWEAK),
    join(targetTweakersRoot, "tweaks", PROJECTS_TWEAK),
    join(targetTweakersRoot, "tweaks", USAGE_TWEAK),
  ]) privateDirectory(path);

  const sourceGlobalState = join(sourceCodexHomeRoot, ".codex-global-state.json");
  const targetGlobalState = join(targetCodexHomeRoot, ".codex-global-state.json");
  privateJson(sourceGlobalState, {
    "local-projects": {
      "local-tweakers": {
        id: "local-tweakers",
        name: "TWEAKERS",
        rootPaths: ["/Users/example/Development/Projects/tweakers"],
        createdAt: 1,
        updatedAt: 2,
        privateAccountMarker: "must-not-migrate",
      },
    },
    "electron-workspace-root-labels": {
      "/Users/example/Development/Projects/tweakers": "TWEAKERS",
      "/Users/example/not-approved": "MUST NOT COPY",
    },
    "electron-persisted-atom-state": { authorization: "Bearer source-secret" },
  });
  privateJson(targetGlobalState, { targetOnly: "preserved" });

  const sourceProjects = join(sourceTweakersRoot, "tweak-data", PROJECTS_TWEAK, "projects-v1.json");
  const targetProjects = join(targetTweakersRoot, "tweak-data", PROJECTS_TWEAK, "projects-v1.json");
  privateJson(sourceProjects, {
    schemaVersion: 1,
    nodes: [
      {
        id: "group-main",
        type: "group",
        parentId: null,
        name: "MAIN",
        icon: { kind: "emoji", value: "📁" },
        color: "#404040",
        connections: {},
      },
      {
        id: "project-tweakers",
        type: "project",
        parentId: "group-main",
        name: "TWEAKERS",
        icon: { kind: "iconify", value: "lucide:wrench" },
        color: "#c2410c",
        colorMode: "manual",
        overlayIntensity: "strong",
        taskSort: "updated-desc",
        projectPath: "/Users/example/Development/Projects/tweakers",
        pinnedTaskIds: [NATIVE_THREAD],
        githubRepo: "private/repository",
        connections: { github: "private-connection-id" },
      },
    ],
  });
  privateJson(targetProjects, { schemaVersion: 1, nodes: [] });

  const sourceConfig = join(sourceTweakersRoot, "config.json");
  const targetConfig = join(targetTweakersRoot, "config.json");
  privateJson(sourceConfig, {
    tweaks: {
      [PROJECTS_TWEAK]: { enabled: true, credential: "must-not-migrate" },
      [USAGE_TWEAK]: { enabled: false },
      "unavailable.private-plugin": { enabled: true, token: "must-not-migrate" },
    },
    accountToken: "must-not-migrate",
  });
  privateJson(targetConfig, { tweaker: { updateChannel: "stable" } });
  privateJson(join(targetTweakersRoot, "tweaks", PROJECTS_TWEAK, "manifest.json"), { id: PROJECTS_TWEAK });
  privateJson(join(targetTweakersRoot, "tweaks", USAGE_TWEAK, "manifest.json"), { id: USAGE_TWEAK });

  privateJson(join(globalRoot, CANONICAL_HISTORY_FILE), {
    version: 1,
    conversations: [{
      conversationId: CONVERSATION,
      rootNativeThreadId: NATIVE_THREAD,
      title: "Existing conversation",
      publicThreadId: PUBLIC_THREAD,
      createdAt: NOW,
      updatedAt: NOW,
      availability: "complete",
      activeClient: null,
      segments: [{
        segmentId: SEGMENT,
        opaqueAccountId: ACCOUNT,
        nativeThreadId: NATIVE_THREAD,
        state: "committed",
        createdAt: NOW,
        committedAt: NOW,
        turns: [],
      }],
    }],
  });

  const input: PortableSettingsMigrationInput = {
    transactionId,
    sourceCodexHomeRoot,
    sourceTweakersRoot,
    targetCodexHomeRoot,
    targetTweakersRoot,
    globalRoot,
    chatgptAppPath,
    tweakersAppPath,
  };
  const dependencies: PortableSettingsMigrationDependencies = {
    census: idleCensus,
    wait: () => undefined,
    now: () => NOW,
  };
  return {
    root,
    input,
    sourceGlobalState,
    targetGlobalState,
    sourceProjects,
    targetProjects,
    sourceConfig,
    targetConfig,
    dependencies,
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("preview is read-only, secret-free, and excludes unproven private settings", () => {
  const f = fixture();
  const before = [f.targetGlobalState, f.targetProjects, f.targetConfig].map(sha256);
  const result = migratePortableSettings(f.input, f.dependencies);
  assert.equal(result.status, "preview");
  assert.equal(result.holdActivation, false);
  assert.equal(result.projectCount, 1);
  assert.equal(result.projectNodeCount, 2);
  assert.equal(result.tweakFlagCount, 2);
  assert.deepEqual([f.targetGlobalState, f.targetProjects, f.targetConfig].map(sha256), before);
  assert.match(result.intentFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert(result.exclusions.includes("native-project-order:unproven-schema"));
  assert(result.exclusions.includes("credentials-cookies-tokens-databases:never-copied"));
  assert(result.exclusions.some((entry) => entry.startsWith("tweak-enablement:unknown-id:")));
  const rendered = JSON.stringify(result);
  assert(!rendered.includes("Bearer source-secret"));
  assert(!rendered.includes("must-not-migrate"));
  assert.equal(inspectPortableSettingsMigration(f.input.targetTweakersRoot, f.input.transactionId).status, "preview");
});

test("apply carries only projects, safe appearance, mapped pins, and known tweak flags", () => {
  const f = fixture("portable-settings-test-apply");
  const preview = migratePortableSettings(f.input, f.dependencies);
  const result = migratePortableSettings({
    ...f.input,
    apply: true,
    expectedIntentFingerprint: preview.intentFingerprint,
  }, f.dependencies);
  assert.equal(result.status, "applied");
  assert.equal(result.holdActivation, false);
  assert.equal(result.nextAction, "activation-remains-user-confirmed");

  const global = readJson(f.targetGlobalState);
  assert.equal(global.targetOnly, "preserved");
  assert.deepEqual(Object.keys(global).sort(), ["electron-workspace-root-labels", "local-projects", "targetOnly"]);
  const native = global["local-projects"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(native["local-tweakers"], {
    id: "local-tweakers",
    name: "TWEAKERS",
    rootPaths: ["/Users/example/Development/Projects/tweakers"],
  });
  const labels = global["electron-workspace-root-labels"] as Record<string, string>;
  assert.deepEqual(labels, { "/Users/example/Development/Projects/tweakers": "TWEAKERS" });

  const projects = readJson(f.targetProjects) as unknown as { schemaVersion: number; nodes: Array<Record<string, unknown>> };
  assert.equal(projects.schemaVersion, 1);
  assert.equal(projects.nodes.length, 2);
  const project = projects.nodes.find((entry) => entry.id === "project-tweakers")!;
  assert.deepEqual(project.pinnedTaskIds, [PUBLIC_THREAD]);
  assert.deepEqual(project.connections, {});
  assert.equal(project.githubRepo, undefined);
  assert.equal(project.color, "#c2410c");
  assert.equal(project.overlayIntensity, "strong");

  const config = readJson(f.targetConfig);
  assert.deepEqual(config.tweaker, { updateChannel: "stable" });
  assert.deepEqual(config.tweaks, {
    [PROJECTS_TWEAK]: { enabled: true },
    [USAGE_TWEAK]: { enabled: false },
  });
  assert.equal(JSON.stringify(global).includes("source-secret"), false);
  assert.equal(JSON.stringify(config).includes("must-not-migrate"), false);
  assert.equal(lstatSync(f.targetGlobalState).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.targetProjects).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.targetConfig).mode & 0o777, 0o600);

  const paths = portableSettingsMigrationPaths(f.input.targetTweakersRoot, f.input.transactionId);
  assert.equal(lstatSync(paths.receipt).mode & 0o777, 0o400);
  assert.equal(inspectPortableSettingsMigration(f.input.targetTweakersRoot, f.input.transactionId).status, "applied");
  const repeated = migratePortableSettings({ ...f.input, apply: true, expectedIntentFingerprint: preview.intentFingerprint }, f.dependencies);
  assert.equal(repeated.status, "applied");
});

test("inspect requires the exact receipt and every committed target", () => {
  for (const scenario of ["missing-receipt", "corrupt-receipt", "tampered-target"] as const) {
    const f = fixture(`portable-inspect-${scenario}`);
    const preview = migratePortableSettings(f.input, f.dependencies);
    migratePortableSettings({
      ...f.input,
      apply: true,
      expectedIntentFingerprint: preview.intentFingerprint,
    }, f.dependencies);
    const paths = portableSettingsMigrationPaths(f.input.targetTweakersRoot, f.input.transactionId);
    if (scenario === "missing-receipt") {
      renameSync(paths.receipt, `${paths.receipt}.missing`);
    } else if (scenario === "corrupt-receipt") {
      chmodSync(paths.receipt, 0o600);
      writeFileSync(paths.receipt, "{}\n", { mode: 0o600 });
      chmodSync(paths.receipt, 0o400);
    } else {
      privateJson(f.targetConfig, { changedAfterReceipt: true });
    }
    const inspected = inspectPortableSettingsMigration(f.input.targetTweakersRoot, f.input.transactionId);
    assert.equal(inspected.status, "manual-recovery-required", scenario);
    assert.equal(inspected.holdActivation, true, scenario);
    assert.equal(inspected.nextAction, "recover-explicitly", scenario);
  }
});

test("destination conflicts block before any transaction or mutation", () => {
  const f = fixture("portable-settings-test-conflict");
  privateJson(f.targetConfig, { tweaks: { [USAGE_TWEAK]: { enabled: true } } });
  const before = sha256(f.targetConfig);
  const preview = migratePortableSettings(f.input, f.dependencies);
  assert.equal(preview.holdActivation, true);
  assert(preview.conflicts.includes(`config.tweaks.${USAGE_TWEAK}.enabled`));
  assert.throws(
    () => migratePortableSettings({ ...f.input, apply: true, expectedIntentFingerprint: preview.intentFingerprint }, f.dependencies),
    /destination-conflict/,
  );
  assert.equal(sha256(f.targetConfig), before);
  assert.equal(lstatExists(portableSettingsMigrationPaths(f.input.targetTweakersRoot, f.input.transactionId).journal), false);
});

test("an active or uncertain writer blocks preview and apply", () => {
  const f = fixture("portable-settings-test-writer");
  let observations = 0;
  const census = (): PortableSettingsWriterCensus => {
    observations += 1;
    return { ...idleCensus(), tweakers: "running" };
  };
  assert.throws(() => migratePortableSettings(f.input, { ...f.dependencies, census }), /portable-settings-writers-not-zero/);
  assert.equal(observations, 1);
  assert.equal(lstatExists(portableSettingsMigrationPaths(f.input.targetTweakersRoot, f.input.transactionId).journal), false);
});

test("apply requires the exact reviewed preview fingerprint and rejects source drift", () => {
  const f = fixture("portable-settings-test-drift");
  const preview = migratePortableSettings(f.input, f.dependencies);
  const source = readJson(f.sourceConfig);
  (source.tweaks as Record<string, { enabled: boolean }>)[PROJECTS_TWEAK]!.enabled = false;
  privateJson(f.sourceConfig, source);
  assert.throws(
    () => migratePortableSettings({ ...f.input, apply: true, expectedIntentFingerprint: preview.intentFingerprint }, f.dependencies),
    /preview-intent-mismatch/,
  );
});

test("unmapped project task identifiers exclude the entire pin family", () => {
  const f = fixture("portable-settings-test-unmapped");
  const projects = readJson(f.sourceProjects) as unknown as { schemaVersion: 1; nodes: Array<Record<string, unknown>> };
  projects.nodes.push({
    id: "project-other",
    type: "project",
    parentId: "group-main",
    name: "OTHER",
    icon: { kind: "emoji", value: "📁" },
    color: "#1d4ed8",
    colorMode: "manual",
    overlayIntensity: "medium",
    pinnedTaskIds: ["unmapped-native-thread"],
    projectPath: "/Users/example/Development/Projects/other",
    connections: {},
  });
  privateJson(f.sourceProjects, projects);
  const preview = migratePortableSettings(f.input, f.dependencies);
  assert(preview.exclusions.includes("projects.pinnedTaskIds:unmapped-family-excluded"));
  const applied = migratePortableSettings({ ...f.input, apply: true, expectedIntentFingerprint: preview.intentFingerprint }, f.dependencies);
  assert.equal(applied.status, "applied");
  const target = readJson(f.targetProjects) as unknown as { nodes: Array<Record<string, unknown>> };
  assert(target.nodes.every((node) => node.pinnedTaskIds === undefined));
});

test("an excluded source pin family does not conflict with valid destination pins", () => {
  const f = fixture("portable-settings-test-unmapped-existing");
  const source = readJson(f.sourceProjects) as unknown as { schemaVersion: 1; nodes: Array<Record<string, unknown>> };
  source.nodes.push({
    id: "project-unmapped",
    type: "project",
    parentId: "group-main",
    name: "UNMAPPED",
    icon: { kind: "emoji", value: "📁" },
    color: "#1d4ed8",
    colorMode: "manual",
    overlayIntensity: "medium",
    pinnedTaskIds: ["unmapped-native-thread"],
    projectPath: "/Users/example/Development/Projects/unmapped",
    connections: {},
  });
  privateJson(f.sourceProjects, source);
  privateJson(f.targetProjects, {
    schemaVersion: 1,
    nodes: source.nodes.slice(0, 2).map((node) => {
      const projected = { ...node, connections: {} };
      delete projected.githubRepo;
      if (projected.id === "project-tweakers") projected.pinnedTaskIds = [PUBLIC_THREAD];
      return projected;
    }),
  });
  const preview = migratePortableSettings(f.input, f.dependencies);
  assert(preview.exclusions.includes("projects.pinnedTaskIds:unmapped-family-excluded"));
  assert.deepEqual(preview.conflicts, []);
});

test("symlinked source artifacts fail closed without a transaction", () => {
  const f = fixture("portable-settings-test-symlink");
  const alternate = join(f.root, "alternate-global.json");
  privateJson(alternate, readJson(f.sourceGlobalState));
  // Replace only inside this disposable fixture.
  const moved = `${f.sourceGlobalState}.original`;
  renameSync(f.sourceGlobalState, moved);
  symlinkSync(alternate, f.sourceGlobalState);
  assert.throws(() => migratePortableSettings(f.input, f.dependencies), /source-global-state-unreadable|source-global-state-unsafe/);
  assert.equal(lstatExists(portableSettingsMigrationPaths(f.input.targetTweakersRoot, f.input.transactionId).journal), false);
});

test("symlinked project parents and bundled tweak directories fail closed", () => {
  const sourceFixture = fixture("portable-settings-test-project-parent-symlink");
  const sourceParent = join(sourceFixture.input.sourceTweakersRoot, "tweak-data", PROJECTS_TWEAK);
  const movedSourceParent = `${sourceParent}.real`;
  renameSync(sourceParent, movedSourceParent);
  symlinkSync(movedSourceParent, sourceParent);
  assert.throws(
    () => migratePortableSettings(sourceFixture.input, sourceFixture.dependencies),
    /source-projects-parent-(?:unsafe|not-canonical)/,
  );

  const tweakFixture = fixture("portable-settings-test-tweak-dir-symlink");
  const tweakRoot = join(tweakFixture.input.targetTweakersRoot, "tweaks", PROJECTS_TWEAK);
  const movedTweakRoot = `${tweakRoot}.real`;
  renameSync(tweakRoot, movedTweakRoot);
  symlinkSync(movedTweakRoot, tweakRoot);
  assert.throws(
    () => migratePortableSettings(tweakFixture.input, tweakFixture.dependencies),
    /target-tweak-directory-unsafe/,
  );
});

test("a pre-journal crash is held, retained, and explicitly recoverable", () => {
  const f = fixture("portable-settings-test-pre-journal-crash");
  const original = [f.targetGlobalState, f.targetProjects, f.targetConfig].map(sha256);
  const preview = migratePortableSettings(f.input, f.dependencies);
  assert.throws(() => migratePortableSettings({
    ...f.input,
    apply: true,
    expectedIntentFingerprint: preview.intentFingerprint,
  }, {
    ...f.dependencies,
    beforePhase(phase) {
      if (phase === "transaction-root-created") throw new Error("synthetic-crash-before-journal");
    },
  }), /synthetic-crash-before-journal/);

  const paths = portableSettingsMigrationPaths(f.input.targetTweakersRoot, f.input.transactionId);
  const interrupted = inspectPortableSettingsMigration(f.input.targetTweakersRoot, f.input.transactionId);
  assert.equal(interrupted.status, "manual-recovery-required");
  assert.equal(interrupted.holdActivation, true);
  assert.equal(interrupted.nextAction, "recover-explicitly");

  const recovered = recoverPortableSettingsMigration(f.input, {
    ...f.dependencies,
    isProcessAlive: () => false,
  });
  assert.equal(recovered.status, "rolled-back");
  assert.deepEqual([f.targetGlobalState, f.targetProjects, f.targetConfig].map(sha256), original);
  assert.equal(lstatExists(paths.transactionRoot), false);
  assert.equal(lstatExists(`${paths.transactionRoot}.pre-journal-aborted`), true);
  assert.equal(lstatExists(paths.lock), false);
  assert.equal(inspectPortableSettingsMigration(f.input.targetTweakersRoot, f.input.transactionId).status, "preview");
});

test("explicit recovery rolls back every crash boundary and never reverses canonical history", () => {
  const cases: Array<{ phase: string; publishingOccurrence?: number; expected: "rolled-back" | "applied" }> = [
    { phase: "journal-prepared", expected: "rolled-back" },
    { phase: "source-sealed", expected: "rolled-back" },
    { phase: "destination-preimages-preserved", expected: "rolled-back" },
    { phase: "candidate-prepared", expected: "rolled-back" },
    { phase: "candidate-verified", expected: "rolled-back" },
    { phase: "publishing", publishingOccurrence: 2, expected: "rolled-back" },
    { phase: "published", expected: "rolled-back" },
    { phase: "receipt-published", expected: "applied" },
  ];
  for (const [index, scenario] of cases.entries()) {
    const f = fixture(`portable-crash-${String(index).padStart(2, "0")}`);
    const original = [f.targetGlobalState, f.targetProjects, f.targetConfig].map(sha256);
    const canonicalBefore = sha256(join(f.input.globalRoot, CANONICAL_HISTORY_FILE));
    const preview = migratePortableSettings(f.input, f.dependencies);
    let occurrence = 0;
    assert.throws(() => migratePortableSettings({
      ...f.input,
      apply: true,
      expectedIntentFingerprint: preview.intentFingerprint,
    }, {
      ...f.dependencies,
      beforePhase(phase) {
        if (phase !== scenario.phase) return;
        occurrence += 1;
        if (occurrence === (scenario.publishingOccurrence ?? 1)) throw new Error(`synthetic-crash-${phase}`);
      },
    }), new RegExp(`synthetic-crash-${scenario.phase}`));
    const recovered = recoverPortableSettingsMigration(f.input, {
      ...f.dependencies,
      isProcessAlive: () => false,
    });
    assert.equal(recovered.status, scenario.expected, scenario.phase);
    if (scenario.expected === "rolled-back") {
      assert.deepEqual([f.targetGlobalState, f.targetProjects, f.targetConfig].map(sha256), original, scenario.phase);
    }
    assert.equal(sha256(join(f.input.globalRoot, CANONICAL_HISTORY_FILE)), canonicalBefore, scenario.phase);
  }
});

test("recovery refuses destination drift without overwriting it", () => {
  const f = fixture("portable-settings-test-recovery-drift");
  const preview = migratePortableSettings(f.input, f.dependencies);
  assert.throws(() => migratePortableSettings({ ...f.input, apply: true, expectedIntentFingerprint: preview.intentFingerprint }, {
    ...f.dependencies,
    beforePhase(phase) { if (phase === "published") throw new Error("synthetic-crash-published"); },
  }), /synthetic-crash-published/);
  privateJson(f.targetConfig, { userChangedAfterCrash: true });
  const changed = sha256(f.targetConfig);
  const recovered = recoverPortableSettingsMigration(f.input, { ...f.dependencies, isProcessAlive: () => false });
  assert.equal(recovered.status, "manual-recovery-required");
  assert.equal(recovered.holdActivation, true);
  assert.equal(sha256(f.targetConfig), changed);
});

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

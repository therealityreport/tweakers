import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import test from "node:test";
import {
  assertEnvironmentCliSuccess,
  environment,
  type EnvironmentCommandDependencies,
} from "../src/commands/environment.js";
import {
  createEnvironmentProfileRegistry,
  createEnvironmentSelection,
  createRequestedEnvironmentSelection,
  type EnvironmentProfileEvidenceInput,
  type LoadedEnvironmentState,
} from "../src/environment-profile.js";
import type {
  EnvironmentCommitHelperReceipt,
  EnvironmentCoordinator,
  EnvironmentTransactionPhase,
  EnvironmentTransactionReceipt,
} from "../src/environment-transaction.js";
import type { ResolvedUserPaths } from "../src/paths.js";
import { lifecycleLockFile } from "../src/lifecycle-lock.js";
import { acquireProcessLock } from "../src/process-lock.js";

const NOW = "2026-07-17T02:00:00.000Z";
const ROOT = "/tmp/tweakers-environment-command";

function paths(): ResolvedUserPaths {
  return {
    root: ROOT,
    runtime: `${ROOT}/runtime`,
    tweaks: `${ROOT}/tweaks`,
    backup: `${ROOT}/backup`,
    configFile: `${ROOT}/config.json`,
    stateFile: `${ROOT}/state.json`,
    deferredRepairFile: `${ROOT}/deferred-repair.json`,
    updateModeFile: `${ROOT}/update-mode.json`,
    selfUpdateStateFile: `${ROOT}/self-update-state.json`,
    binDir: `${ROOT}/bin`,
    logDir: `${ROOT}/log`,
    transactionRoot: `${ROOT}/transactions/app-install`,
    transactionStateFile: `${ROOT}/transactions/app-install.json`,
    environmentRegistryFile: `${ROOT}/environment-registry.json`,
    environmentProfileFile: `${ROOT}/environment-registry.json`,
    legacyEnvironmentProfileFile: `${ROOT}/environment-profiles.json`,
    environmentSelectionFile: `${ROOT}/environment-selection.json`,
    environmentTransactionFile: `${ROOT}/transactions/environment.json`,
    environmentReceiptRoot: `${ROOT}/transactions/environment`,
    environmentLockFile: `${ROOT}/transactions/environment.lock`,
  };
}

function trustedEvidence(release: "stable" | "alpha"): EnvironmentProfileEvidenceInput {
  return {
    officialVersion: release === "stable" ? "26.707.1" : "26.717.1",
    officialBuild: release === "stable" ? "5900" : "6001",
    strictSignature: true,
    gatekeeper: true,
    teamIdentifier: "2DC432GLL2",
    designatedRequirement:
      `designated => identifier "${release === "stable" ? "com.openai.codex" : "com.openai.codex.beta"}" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"`,
    signatureCheckedAt: NOW,
    officialBackendVersion: release === "stable" ? "0.144.5" : "0.145.0-alpha.19",
    officialBackendFingerprint: `${release}-official-backend`,
    backendVersion: release === "stable" ? "0.144.5" : "0.145.0-alpha.19",
    backendFingerprint: `${release}-selected-backend`,
    pristineBackupFingerprint: `${release}-pristine`,
    patchedPayloadFingerprint: `${release}-patched`,
    backendInstallable: release === "alpha",
    patchedPayloadBuildable: true,
  };
}

function loadedState(): LoadedEnvironmentState {
  const base = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: ROOT,
    stableEvidence: trustedEvidence("stable"),
    alphaEvidence: trustedEvidence("alpha"),
  });
  const current = createEnvironmentSelection({
    profile: base.profiles.stable,
    appExperience: "chatgpt",
    requestedAt: NOW,
    appliedAt: NOW,
  });
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: ROOT,
    selected: current,
    lastKnownWorkingSelection: current,
    stableEvidence: trustedEvidence("stable"),
    alphaEvidence: trustedEvidence("alpha"),
  });
  return { registry, current, migratedFromLegacy: false };
}

function receipt(
  transactionId = "environment-1",
  phase: EnvironmentTransactionPhase = "prepared",
): EnvironmentTransactionReceipt {
  const loaded = loadedState();
  const requested = createRequestedEnvironmentSelection(
    loaded.registry,
    { appExperience: "tweakers", releaseProfile: "alpha" },
    NOW,
  );
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId,
    phase,
    error: null,
    ownerPid: 99,
    source: loaded.current,
    requested,
    prepared: null,
    applied: null,
    oldMainPid: 100,
    newMainPid: null,
    attempt: 0,
    createdAt: NOW,
    updatedAt: NOW,
    committedAt: null,
    rolledBackAt: null,
    cancelledAt: null,
  };
}

function fakeCoordinator(overrides: Partial<EnvironmentCoordinator> = {}): EnvironmentCoordinator {
  let current: EnvironmentTransactionReceipt | null = receipt();
  return {
    prepare: async ({ current: source, requested }) => {
      current = { ...receipt(), source, requested };
      return current;
    },
    commit: async () => current!,
    status: () => current,
    verify: async () => ({
      ok: true,
      observedPid: 101,
      visibleWindow: true,
      appliedSelection: current?.requested ?? null,
      appliedEvidence: null,
      error: null,
    }),
    rollback: async () => current!,
    recover: async () => current!,
    cancel: async () => current!,
    ...overrides,
  };
}

function helperReceipt(input: {
  transactionId: string;
  cliPath: string;
  cliArtifactDigest: string;
  managedRuntimeArtifactPath: string;
  managedRuntimeArtifactDigest: string;
  userRoot: string;
  receiptFile: string;
}): EnvironmentCommitHelperReceipt {
  const root = input.receiptFile.slice(0, -"commit-helper.json".length);
  return {
    schemaVersion: 1,
    kind: "environment-commit-helper",
    transactionId: input.transactionId,
    label: `co.tweakers.environment.${input.transactionId}`,
    cliPath: input.cliPath,
    cliArtifactDigest: input.cliArtifactDigest,
    managedRuntimeArtifactPath: input.managedRuntimeArtifactPath,
    managedRuntimeArtifactDigest: input.managedRuntimeArtifactDigest,
    userRoot: input.userRoot,
    wrapperFile: `${root}helper.sh`,
    stdoutFile: `${root}stdout.log`,
    stderrFile: `${root}stderr.log`,
    outcomeFile: `${root}outcome.json`,
    phase: "submitted",
    submittedAt: NOW,
    error: null,
  };
}

function dependencies(overrides: Partial<EnvironmentCommandDependencies> = {}) {
  const printed: string[] = [];
  const writes: string[] = [];
  const loadInputs: Parameters<EnvironmentCommandDependencies["loadState"]>[0][] = [];
  const coordinators: Parameters<EnvironmentCommandDependencies["createCoordinator"]>[0][] = [];
  const submits: Parameters<EnvironmentCommandDependencies["submitCommitHelper"]>[0][] = [];
  const state = loadedState();
  const coordinator = fakeCoordinator();
  const deps: EnvironmentCommandDependencies = {
    paths,
    loadState: (input) => {
      loadInputs.push(input);
      return state;
    },
    inspectProfile: () => trustedEvidence("stable"),
    inspectManagedAlpha: () => ({
      installed: true,
      binaryPath: `${ROOT}/codex-cli/releases/alpha/codex`,
      version: "0.145.0-alpha.19",
      fingerprint: "alpha-managed",
      error: null,
    }),
    writeRegistry: (file) => { writes.push(file); },
    preparationCapabilities: () => ({ patchedPayloadBuildable: true, backendInstallable: true }),
    createRequestedSelection: createRequestedEnvironmentSelection,
    createCoordinator: (options) => {
      coordinators.push(options);
      return coordinator;
    },
    submitCommitHelper: (input) => {
      submits.push(input);
      return helperReceipt(input);
    },
    readRegistry: () => state.registry,
    resolvePreparedCommitCli: (receipt, receiptRoot) => ({
      cliPath: `${receiptRoot}/${receipt.transactionId}/prepared/managed-runtime/requested/packages/installer/dist/cli.js`,
      cliArtifactDigest: "a".repeat(64),
      managedRuntimeArtifactPath: `${receiptRoot}/${receipt.transactionId}/prepared/managed-runtime/requested`,
      managedRuntimeArtifactDigest: "b".repeat(64),
    }),
    print: (value) => { printed.push(value); },
    ...overrides,
  };
  return { deps, state, coordinator, printed, writes, loadInputs, coordinators, submits };
}

test("status is read-only and reports per-app-experience availability from recomputed truth", async () => {
  const fixture = dependencies();

  const result = await environment("status", { json: true }, fixture.deps);

  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.coordinators.length, 0);
  assert.equal(fixture.loadInputs.length, 1);
  assert.deepEqual(fixture.loadInputs[0], {
    legacyStateFile: `${ROOT}/state.json`,
    registryFile: `${ROOT}/environment-registry.json`,
    selectionFile: `${ROOT}/environment-selection.json`,
    environmentRoot: ROOT,
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    stableEvidence: { patchedPayloadBuildable: true },
    alphaEvidence: {
      backendInstallable: true,
      patchedPayloadBuildable: true,
    },
  });
  assert.equal(result.schemaVersion, 1);
  assert.ok("channels" in result);
  assert.equal(result.channels.alpha.availability.chatgpt.available, true);
  assert.equal(result.channels.alpha.availability.tweakers.available, true);
  assert.equal(fixture.printed.length, 1);
  assert.deepEqual(JSON.parse(fixture.printed[0]), result);
});

test("environment gc requires an explicit dry-run or apply mode", async () => {
  const fixture = dependencies();
  mkdirSync(`${ROOT}/transactions/environment`, { recursive: true });
  try {
    const preview = await environment("gc", { dryRun: true, json: true }, fixture.deps);
    assert.equal("kind" in preview && preview.kind, "environment-gc");
    assert.equal("mode" in preview && preview.mode, "dry-run");
    await assert.rejects(
      () => environment("gc", { json: true }, fixture.deps),
      /exactly one of --dry-run or --apply/,
    );
    await assert.rejects(
      () => environment("gc", { dryRun: true, apply: true, json: true }, fixture.deps),
      /exactly one of --dry-run or --apply/,
    );
  } finally {
    rmSync(ROOT, { recursive: true, force: true });
  }
});

test("environment document recovery and publication wait for the shared lifecycle owner", async () => {
  const fixture = dependencies();
  const lock = acquireProcessLock(lifecycleLockFile(ROOT));
  try {
    for (const [action, options] of [
      ["status", { json: true }],
      ["register-alpha", { appPath: "/Users/test/OpenAI Beta.app", json: true }],
      ["prepare", { appExperience: "tweakers", releaseProfile: "alpha", json: true }],
    ] as const) {
      await assert.rejects(
        environment(action, options, fixture.deps),
        /Another Tweakers lifecycle operation is active/i,
      );
    }
    assert.equal(fixture.loadInputs.length, 0);
    assert.equal(fixture.writes.length, 0);
  } finally {
    lock.release();
  }
});

test("status --observe remains available while the lifecycle lease is held", async () => {
  const fixture = dependencies();
  const lock = acquireProcessLock(lifecycleLockFile(ROOT));
  try {
    const result = await environment("status", { observe: true, json: true }, fixture.deps);
    assert.ok("channels" in result);
    assert.equal(result.observation?.lifecycleContended, true);
    assert.equal(result.observation?.freshness, "contended");
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.loadInputs.length, 1);
  } finally {
    lock.release();
  }
});

test("status --observe never runs expensive profile or managed Alpha verification", async () => {
  const observedState = loadedState();
  const unverifiedRegistry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: ROOT,
  });
  const expensiveCalls: string[] = [];
  const cachedVersions: Array<string | null | undefined> = [];
  const fixture = dependencies({
    loadState: (_input, loadDependencies) => {
      assert.ok(loadDependencies.inspectProfile);
      cachedVersions.push(loadDependencies.inspectProfile(
        unverifiedRegistry.profiles.stable,
        observedState.current,
        observedState.registry.profiles.stable,
      ).officialVersion);
      cachedVersions.push(loadDependencies.inspectProfile(
        unverifiedRegistry.profiles.alpha,
        observedState.current,
        observedState.registry.profiles.alpha,
      ).officialVersion);
      return observedState;
    },
    inspectProfile: (profile) => {
      expensiveCalls.push(`profile:${profile.releaseProfile}`);
      return trustedEvidence(profile.releaseProfile);
    },
    inspectManagedAlpha: () => {
      expensiveCalls.push("managed-alpha");
      return {
        installed: true,
        binaryPath: `${ROOT}/codex-cli/releases/alpha/codex`,
        version: "0.145.0-alpha.19",
        fingerprint: "alpha-managed",
        error: null,
      };
    },
  });

  await environment("status", { observe: true, json: true }, fixture.deps);

  assert.deepEqual(expensiveCalls, []);
  assert.deepEqual(cachedVersions, ["26.707.1", "26.717.1"]);

  await environment("status", { json: true }, fixture.deps);

  assert.deepEqual(expensiveCalls, [
    "managed-alpha",
    "profile:stable",
    "profile:alpha",
  ]);
});

test("register-alpha validates a native-selected absolute app path and preserves selection", async () => {
  const fixture = dependencies({
    registerAlpha: (registry, appPath) => ({
      ...registry,
      profiles: { ...registry.profiles, alpha: { ...registry.profiles.alpha, officialPath: appPath, selectedDesktopPath: appPath } },
    }),
  });
  const result = await environment("register-alpha", { appPath: "/Users/test/OpenAI Beta.app", json: true }, fixture.deps);
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0], `${ROOT}/environment-registry.json`);
  assert.equal((result as { selected: { selectedDesktopPath: string } }).selected.selectedDesktopPath, "/Applications/ChatGPT.app");
  await assert.rejects(
    environment("register-alpha", { appPath: "relative/Beta.app" }, fixture.deps),
    /exact absolute \.app path/,
  );
});

test("prepare normalizes Sade option keys, publishes only recomputed registry evidence, and stages one selection", async () => {
  const prepared: Array<{ appExperience: string; releaseProfile: string }> = [];
  const fixture = dependencies({
    createCoordinator: () => fakeCoordinator({
      prepare: async ({ current, requested }) => {
        prepared.push({
          appExperience: requested.appExperience,
          releaseProfile: requested.releaseProfile,
        });
        return { ...receipt("prepared-1"), source: current, requested };
      },
    }),
  });

  const result = await environment("prepare", {
    "app-experience": "tweakers",
    releaseProfile: "alpha",
    json: true,
  }, fixture.deps);

  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0], `${ROOT}/environment-registry.json`);
  assert.deepEqual(prepared, [{ appExperience: "tweakers", releaseProfile: "alpha" }]);
  assert.equal("transactionId" in result ? result.transactionId : null, "prepared-1");
  assert.equal(fixture.printed.length, 1);
});

test("prepare forwards only an explicit internal bundled-derived receipt to the production coordinator", async () => {
  const coordinatorInputs: Parameters<EnvironmentCommandDependencies["createCoordinator"]>[0][] = [];
  const fixture = dependencies({
    createCoordinator: (options) => {
      coordinatorInputs.push(options);
      return fakeCoordinator();
    },
  });
  const receiptFile = `${ROOT}/codex-source/receipts/bundled-derived.json`;

  await environment("prepare", {
    appExperience: "tweakers",
    releaseProfile: "stable",
    "bundled-derived-receipt": receiptFile,
    json: true,
  }, fixture.deps);

  assert.equal(coordinatorInputs.length, 1);
  assert.equal(coordinatorInputs[0]?.bundledDerivedReceiptFile, receiptFile);

  const external = dependencies();
  await assert.rejects(
    environment("prepare", {
      appExperience: "tweakers",
      releaseProfile: "stable",
      bundledDerivedReceipt: "/Volumes/HardDrive/receipt.json",
    }, external.deps),
    /internal filesystem/,
  );
  assert.equal(external.writes.length, 0);
});

test("prepare rejects invalid or conflicting enums before writing state", async () => {
  const invalid = dependencies();
  await assert.rejects(
    environment("prepare", { appExperience: "other", releaseProfile: "stable" }, invalid.deps),
    /app experience must be chatgpt or tweakers/,
  );
  assert.equal(invalid.writes.length, 0);

  const conflicting = dependencies();
  await assert.rejects(
    environment("prepare", {
      appExperience: "chatgpt",
      "app-experience": "tweakers",
      releaseProfile: "stable",
    }, conflicting.deps),
    /Conflicting app experience options/,
  );
  assert.equal(conflicting.writes.length, 0);
});

test("submit accepts only the matching prepared receipt and derives helper paths internally", async () => {
  const prepared = receipt("safe-id", "prepared");
  const fixture = dependencies({
    createCoordinator: () => fakeCoordinator({ status: () => prepared }),
  });

  const result = await environment("submit", { transaction: "safe-id", json: true }, fixture.deps);

  assert.equal(result.kind, "environment-commit-helper");
  assert.deepEqual(fixture.submits, [{
    transactionId: "safe-id",
    cliPath: `${ROOT}/transactions/environment/safe-id/prepared/managed-runtime/requested/packages/installer/dist/cli.js`,
    cliArtifactDigest: "a".repeat(64),
    managedRuntimeArtifactPath: `${ROOT}/transactions/environment/safe-id/prepared/managed-runtime/requested`,
    managedRuntimeArtifactDigest: "b".repeat(64),
    userRoot: ROOT,
    receiptFile: `${ROOT}/transactions/environment/safe-id/commit-helper.json`,
  }]);
  assert.equal(fixture.printed.length, 1);
});

test("submit fails closed for missing, mismatched, non-prepared, or unsafe transaction IDs", async () => {
  for (const testCase of [
    { status: null, id: "safe-id", error: /No environment transaction receipt/ },
    { status: receipt("different", "prepared"), id: "safe-id", error: /transaction mismatch/i },
    { status: receipt("safe-id", "preparing"), id: "safe-id", error: /cannot submit from phase preparing/ },
    { status: receipt("safe-id", "prepared"), id: "..\/escape", error: /transaction ID is invalid/ },
  ] as const) {
    const submits: Parameters<EnvironmentCommandDependencies["submitCommitHelper"]>[0][] = [];
    const fixture = dependencies({
      createCoordinator: () => fakeCoordinator({ status: () => testCase.status }),
      submitCommitHelper: (input) => {
        submits.push(input);
        return helperReceipt(input);
      },
    });
    await assert.rejects(
      environment("submit", { transaction: testCase.id }, fixture.deps),
      testCase.error,
    );
    assert.equal(submits.length, 0);
    assert.equal(fixture.printed.length, 0);
  }
});

test("transaction returns schema-1 idle JSON and commit/verify/rollback/recover/cancel delegate exact IDs", async () => {
  const calls: string[] = [];
  const noTransaction = dependencies({
    createCoordinator: () => fakeCoordinator({ status: () => null }),
  });
  const idle = await environment("transaction", { json: true }, noTransaction.deps);
  assert.deepEqual(idle, {
    schemaVersion: 1,
    kind: "environment",
    transactionId: null,
    phase: "idle",
  });
  assert.equal(noTransaction.printed.length, 1);

  const fixture = dependencies({
    createCoordinator: () => fakeCoordinator({
      commit: async (id) => { calls.push(`commit:${id}`); return receipt(id); },
      verify: async (id) => {
        calls.push(`verify:${id}`);
        return {
          ok: true,
          observedPid: 101,
          visibleWindow: true,
          appliedSelection: loadedState().current,
          appliedEvidence: null,
          error: null,
        };
      },
      rollback: async (id) => { calls.push(`rollback:${id}`); return receipt(id); },
      recover: async (id) => { calls.push(`recover:${id}`); return receipt(id, "cancelled"); },
      cancel: async (id) => { calls.push(`cancel:${id}`); return receipt(id); },
    }),
  });
  for (const action of ["commit", "verify", "rollback", "recover", "cancel"] as const) {
    await environment(action, { transaction: "exact-id", json: true }, fixture.deps);
  }
  assert.deepEqual(calls, [
    "commit:exact-id",
    "verify:exact-id",
    "rollback:exact-id",
    "recover:exact-id",
    "cancel:exact-id",
  ]);
  assert.equal(fixture.printed.length, 5);
});

test("CLI action success requires an allowed terminal receipt phase", () => {
  assert.doesNotThrow(() => assertEnvironmentCliSuccess("commit", receipt("exact-id", "committed")));
  for (const phase of ["rolled-back", "failed", "cancelled"] as const) {
    assert.throws(
      () => assertEnvironmentCliSuccess("commit", receipt("exact-id", phase)),
      new RegExp(`phase ${phase}`),
    );
  }
  for (const phase of ["committed", "rolled-back", "cancelled"] as const) {
    assert.doesNotThrow(() => assertEnvironmentCliSuccess("recover", receipt("exact-id", phase)));
  }
  assert.throws(
    () => assertEnvironmentCliSuccess("recover", receipt("exact-id", "failed")),
    /phase failed/,
  );
  assert.doesNotThrow(() => assertEnvironmentCliSuccess("status", receipt("exact-id", "failed")));
});

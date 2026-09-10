import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createTweakersManagerStatusSnapshot,
  managerStatusPaths,
  type ManagerStatusPaths,
} from "../src/manager-status";
import { ManagerOperationStore } from "../src/manager-operation-store";
import type { ManagerRefreshTimingEvidenceV1, TweakersManagerPreparedOperationV1 } from "../src/manager-contract";

const NOW = "2026-08-27T12:00:00.000Z";

test("manager status is side-effect-free for a missing user root", () => {
  const parent = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  const root = join(parent, "missing-user-root");
  try {
    const beforeFilesystem = directorySnapshot(parent);
    const beforeProcess = processSnapshot();

    const snapshot = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.injected", "refresh.independent"],
    }, fixedDependencies());

    assert.equal(snapshot.status.installation.state, "not-installed");
    assert.equal(snapshot.status.updater.state, "idle");
    assert.deepEqual(
      snapshot.status.receipts.map((receipt) => [receipt.source, receipt.state, receipt.revision]),
      [
        ["environment", "missing", "missing"],
        ["chatgpt-app-update", "missing", "missing"],
        ["desktop-update", "missing", "missing"],
        ["environment-mode-cache", "missing", "missing"],
        ["official-source", "missing", "missing"],
      ],
    );
    assert.equal(snapshot.status.coordinator.state, "idle");
    assert.equal(snapshot.actions.every((action) => action.available === false), true);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.status.receipts), true);
    assert.deepEqual(directorySnapshot(parent), beforeFilesystem);
    assert.deepEqual(processSnapshot(), beforeProcess);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("manager status retains malformed and partial receipt evidence without repairing it", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  try {
    const paths = managerStatusPaths(root);
    writeFixture(paths.environmentSelectionFile, "{\"releaseProfile\":\"stable\"}\n");
    writeFixture(paths.desktopUpdateReceiptFile, "{\"schemaVersion\":1,\"kind\":\"desktop-update\",\"transactionId\":\"update-1\"}\n");
    writeFixture(paths.environmentTransactionFile, "{not JSON\n");
    writeFixture(paths.environmentModeCacheCurrentFile, "{\"schemaVersion\":2,\"kind\":\"environment-mode-pair\"}\n");
    const beforeFilesystem = directorySnapshot(root);
    const beforeProcess = processSnapshot();

    const snapshot = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.injected", "refresh.independent"],
    }, fixedDependencies());
    const environmentReceipt = receipt(snapshot, "environment");
    const desktopReceipt = receipt(snapshot, "desktop-update");
    const cacheReceipt = receipt(snapshot, "environment-mode-cache");

    assert.equal(snapshot.status.environment.selection.state, "malformed");
    assert.equal(snapshot.status.updater.state, "malformed");
    assert.equal(environmentReceipt.state, "malformed");
    assert.match(environmentReceipt.problem ?? "", /invalid JSON/);
    assert.equal(desktopReceipt.state, "malformed");
    assert.equal(cacheReceipt.state, "malformed");
    assert.notEqual(environmentReceipt.revision, "malformed");
    assert.deepEqual(directorySnapshot(root), beforeFilesystem);
    assert.deepEqual(processSnapshot(), beforeProcess);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official ChatGPT updates and historical combined failures have separate projections", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  try {
    const paths = managerStatusPaths(root);
    writeFixture(paths.stateFile, JSON.stringify({
      version: "26.831.20005",
      installedAt: NOW,
      appRoot: "/Applications/ChatGPT.app",
      mode: "chatgpt",
    }));
    writeFixture(paths.independentStateFile, JSON.stringify({
      version: "1.0.0",
      codexVersion: "26.831.20005",
      installedAt: NOW,
      appRoot: "/Applications/Tweakers.app",
      mode: "tweakers",
    }));
    writeFixture(paths.desktopUpdateReceiptFile, JSON.stringify({
      ...desktopReceipt("legacy-combined", "failed"),
      error: "Development source changed while the promotion candidate was being built",
      resumable: false,
      safeOfficialMode: true,
    }));
    writeFixture(paths.chatgptAppUpdateReceiptFile, JSON.stringify({
      ...desktopReceipt("official-update", "completed"),
      observed: { marketingVersion: "26.831.21537", build: "7579" },
      completedAt: NOW,
      terminalAt: NOW,
    }));
    writeFixture(paths.environmentRegistryFile, JSON.stringify({
      schemaVersion: 1,
      profiles: {
        stable: {
          officialPath: "/Applications/ChatGPT.app",
          officialBundleId: "com.openai.codex",
          officialVersion: "26.831.21537",
          officialBuild: "7579",
          strictSignature: true,
          gatekeeper: true,
        },
      },
    }));
    writeFixture(paths.environmentSelectionFile, JSON.stringify({
      releaseProfile: "stable",
      appExperience: "chatgpt",
      migrationState: "verified",
    }));

    const snapshot = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.injected", "refresh.independent"],
    }, fixedDependencies());

    assert.equal(snapshot.status.chatgptAppUpdate.state, "terminal");
    assert.equal(snapshot.status.chatgptAppUpdate.phase, "completed");
    assert.equal(snapshot.status.chatgptAppUpdate.error, null);
    assert.equal(snapshot.status.installation.appRoot, "/Applications/ChatGPT.app");
    assert.equal(snapshot.status.independentInstallation.appRoot, "/Applications/Tweakers.app");
    assert.equal(snapshot.status.injectedPatch.state, "reinjection-required");
    assert.equal(snapshot.status.injectedPatch.candidateReady, true);
    assert.equal(snapshot.status.updater.state, "terminal");
    assert.equal(snapshot.status.updater.phase, "failed");
    assert.equal(snapshot.status.tweakersPatch.state, "source-changes-available");
    assert.equal(snapshot.status.tweakersPatch.installedVersion, "26.831.20005");
    assert.equal(snapshot.status.tweakersPatch.officialVersion, "26.831.21537");
    assert.equal(snapshot.actions.some((action) => action.actionId.startsWith("desktop-update.")), false);
    assert.equal(snapshot.actions.find((action) => action.actionId === "refresh.independent")?.available, true);
    assert.equal(snapshot.actions.find((action) => action.actionId === "refresh.injected")?.available, true);
    assert.match(snapshot.actions.find((action) => action.actionId === "refresh.injected")?.reason ?? "", /sealed stable ChatGPT source/);

    writeFixture(paths.independentStateFile, JSON.stringify({
      version: "1.0.0",
      codexVersion: "26.831.21537",
      installedAt: NOW,
      appRoot: "/Applications/Tweakers.app",
      mode: "tweakers",
    }));
    const rebuilt = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.injected", "refresh.independent"],
    }, fixedDependencies());
    assert.equal(rebuilt.status.tweakersPatch.state, "current");
    assert.equal(rebuilt.status.tweakersPatch.installedVersion, "26.831.21537");
    assert.equal(rebuilt.actions.find((action) => action.actionId === "refresh.independent")?.available, true);
    assert.match(
      rebuilt.actions.find((action) => action.actionId === "refresh.independent")?.reason ?? "",
      /without updating ChatGPT/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pristine verified stable ChatGPT selection can prepare its first receipt-bound injection without creating state", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  try {
    const paths = managerStatusPaths(root);
    writeFixture(paths.environmentRegistryFile, JSON.stringify({
      schemaVersion: 1,
      profiles: {
        stable: {
          officialPath: "/Applications/ChatGPT.app",
          officialBundleId: "com.openai.codex",
          officialVersion: "26.831.21537",
          officialBuild: "7579",
          strictSignature: true,
          gatekeeper: true,
        },
      },
    }));
    writeFixture(paths.environmentSelectionFile, JSON.stringify({
      releaseProfile: "stable",
      appExperience: "chatgpt",
      migrationState: "verified",
    }));
    const before = directorySnapshot(root);

    const snapshot = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.injected"],
    }, fixedDependencies());

    assert.equal(existsSync(paths.stateFile), false);
    assert.equal(snapshot.status.installation.state, "not-installed");
    assert.equal(snapshot.status.injectedPatch.state, "reinjection-required");
    assert.equal(snapshot.status.injectedPatch.installedVersion, null);
    assert.equal(snapshot.status.injectedPatch.candidateReady, true);
    assert.equal(snapshot.actions.find((action) => action.actionId === "refresh.injected")?.available, true);
    assert.deepEqual(directorySnapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official ChatGPT identity remains diagnostic-only rather than a manager updater action", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  try {
    const paths = managerStatusPaths(root);
    writeFixture(paths.environmentRegistryFile, JSON.stringify({
      schemaVersion: 1,
      profiles: {
        stable: {
          officialPath: "/Applications/ChatGPT.app",
          officialBundleId: "com.openai.codex",
          officialVersion: "26.831.21537",
          officialBuild: "7579",
          strictSignature: true,
          gatekeeper: true,
        },
      },
    }));
    writeFixture(paths.environmentSelectionFile, JSON.stringify({
      releaseProfile: "stable",
      appExperience: "chatgpt",
      migrationState: "verified",
    }));

    const snapshot = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());

    assert.equal(snapshot.status.installation.state, "not-installed");
    assert.equal(snapshot.status.independentInstallation.state, "not-installed");
    assert.equal(snapshot.status.environment.officialApp.appPath, "/Applications/ChatGPT.app");
    assert.equal(snapshot.actions.some((action) => action.actionId.startsWith("desktop-update.")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager gates independent refresh on a current sealed official source and exposes only the fixed registration action when one is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  try {
    const paths = managerStatusPaths(root);
    writeFixture(paths.independentStateFile, JSON.stringify({
      version: "1.0.0",
      codexVersion: "26.831.21537",
      installedAt: NOW,
      appRoot: "/Applications/Tweakers.app",
      mode: "tweakers",
    }));
    writeFixture(paths.environmentRegistryFile, JSON.stringify({
      schemaVersion: 1,
      profiles: {
        stable: {
          officialPath: "/Applications/ChatGPT.app",
          officialBundleId: "com.openai.codex",
          officialVersion: "26.831.21537",
          officialBuild: "7579",
          strictSignature: true,
          gatekeeper: true,
        },
      },
    }));
    writeFixture(paths.environmentSelectionFile, JSON.stringify({
      releaseProfile: "stable",
      appExperience: "chatgpt",
      migrationState: "verified",
    }));
    const missing = {
      ...readyRegisteredOfficialSource(),
      state: "missing" as const,
      generationId: null,
      receiptDigest: null,
      artifactPath: null,
      version: null,
      build: null,
      sourceDigest: null,
      problem: null,
    };
    const beforeRegistration = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["official-source.register", "refresh.independent"],
    }, { now: () => NOW, registeredOfficialSource: () => missing });
    assert.equal(beforeRegistration.actions.find((action) => action.actionId === "official-source.register")?.available, true);
    assert.equal(beforeRegistration.actions.find((action) => action.actionId === "refresh.independent")?.available, false);
    assert.match(
      beforeRegistration.actions.find((action) => action.actionId === "refresh.independent")?.reason ?? "",
      /verified official source/,
    );

    const afterRegistration = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["official-source.register", "refresh.independent"],
    }, fixedDependencies());
    assert.equal(afterRegistration.actions.find((action) => action.actionId === "official-source.register")?.available, false);
    assert.equal(afterRegistration.actions.find((action) => action.actionId === "refresh.independent")?.available, true);
    assert.match(
      afterRegistration.actions.find((action) => action.actionId === "refresh.independent")?.reason ?? "",
      /without updating ChatGPT/,
    );

    const projectedStale = {
      ...readyRegisteredOfficialSource(),
      state: "stale" as const,
      candidateDigest: null,
      problem: "The fixed official ChatGPT source changed after registration",
    };
    const strictStale = {
      ...projectedStale,
      candidateDigest: "d".repeat(64),
    };
    const observerCalls: string[] = [];
    const staleDependencies = {
      now: () => NOW,
      registeredOfficialSource: () => {
        observerCalls.push("projected");
        return projectedStale;
      },
      strictRegisteredOfficialSource: () => {
        observerCalls.push("strict");
        return strictStale;
      },
    };
    const projectedRegistration = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["official-source.register"],
    }, staleDependencies);
    assert.equal(projectedRegistration.actions.find((action) => action.actionId === "official-source.register")?.available, false);
    assert.deepEqual(observerCalls, ["projected"]);

    const strictRegistration = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["official-source.register"],
      officialSourceVerification: "strict",
    }, staleDependencies);
    assert.equal(strictRegistration.actions.find((action) => action.actionId === "official-source.register")?.available, true);
    assert.equal(strictRegistration.status.environment.registeredStableSource.candidateDigest, "d".repeat(64));
    assert.notEqual(strictRegistration.stateToken, projectedRegistration.stateToken);
    assert.deepEqual(observerCalls, ["projected", "strict"]);

    const strictFailure = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["official-source.register"],
      officialSourceVerification: "strict",
    }, {
      now: () => NOW,
      registeredOfficialSource: () => strictStale,
      strictRegisteredOfficialSource: () => ({
        ...projectedStale,
        problem: "Strict official-source observation failed",
      }),
    });
    assert.equal(strictFailure.actions.find((action) => action.actionId === "official-source.register")?.available, false);
    assert.match(
      strictFailure.actions.find((action) => action.actionId === "official-source.register")?.reason ?? "",
      /Strict official-source observation failed/,
    );
    assert.equal(strictFailure.status.environment.registeredStableSource.candidateDigest, null);

    // A historical updater receipt remains visible for diagnostics but does
    // not create a current executable manager route or block sealed refresh.
    writeFixture(paths.chatgptAppUpdateReceiptFile, JSON.stringify({
      ...desktopReceipt("official-update-active", "completed"),
      phase: "awaiting_native_update",
    }));
    const duringDesktopUpdate = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["official-source.register", "refresh.independent"],
    }, { now: () => NOW, registeredOfficialSource: () => missing });
    for (const actionId of ["official-source.register", "refresh.independent"] as const) {
      assert.equal(duringDesktopUpdate.actions.find((action) => action.actionId === actionId)?.available, actionId === "official-source.register");
    }

    // The same barrier applies to an active environment transaction.
    writeFixture(paths.chatgptAppUpdateReceiptFile, JSON.stringify(desktopReceipt("official-update-active", "completed")));
    writeFixture(paths.environmentTransactionFile, JSON.stringify(environmentReceipt("environment-active")));
    const duringEnvironmentChange = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["official-source.register", "refresh.independent"],
    }, { now: () => NOW, registeredOfficialSource: () => missing });
    for (const actionId of ["official-source.register", "refresh.independent"] as const) {
      assert.equal(duringEnvironmentChange.actions.find((action) => action.actionId === actionId)?.available, false);
      assert.match(duringEnvironmentChange.actions.find((action) => action.actionId === actionId)?.reason ?? "", /receipt is already active/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state tokens are deterministic and change when receipt chronology changes without a visible ABA change", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  try {
    const paths = managerStatusPaths(root);
    writeFixture(paths.configFile, "{\"tweaker\":{\"safeMode\":false}}\n");
    writeFixture(paths.stateFile, JSON.stringify({
      version: "1.0.0",
      installedAt: NOW,
      appRoot: "/Applications/ChatGPT.app",
      runtimeUpdatedAt: NOW,
      mode: "tweakers",
    }));
    writeFixture(paths.environmentSelectionFile, JSON.stringify({
      releaseProfile: "stable",
      appExperience: "tweakers",
      migrationState: "verified",
    }));
    writeFixture(paths.environmentTransactionFile, JSON.stringify(environmentReceipt("A")));

    const first = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());
    const repeated = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());
    assert.deepEqual(repeated, first);

    // This extra durable chronology marker is not presented as an operation
    // field. The visible receipt id/phase/timestamps return to the same values
    // (an ABA-shaped observation), while its exact receipt revision changes.
    writeFixture(paths.environmentTransactionFile, JSON.stringify({
      ...environmentReceipt("B"),
      chronologyMarker: "replacement-receipt-with-same-visible-state",
    }));
    const second = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());
    const firstReceipt = receipt(first, "environment");
    const secondReceipt = receipt(second, "environment");

    assert.equal(secondReceipt.receiptId, firstReceipt.receiptId);
    assert.equal(secondReceipt.phase, firstReceipt.phase);
    assert.equal(secondReceipt.updatedAt, firstReceipt.updatedAt);
    assert.notEqual(secondReceipt.revision, firstReceipt.revision);
    assert.notEqual(second.stateToken, first.stateToken);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager status can be collected from injected readers without touching the host filesystem", () => {
  const root = "/virtual/tweakers";
  const paths = managerStatusPaths(root);
  const files = new Map<string, string>([
    [paths.stateFile, JSON.stringify({ version: "1.0.0", installedAt: NOW, appRoot: "/Applications/ChatGPT.app", mode: "chatgpt" })],
    [paths.environmentTransactionFile, JSON.stringify(environmentReceipt("virtual-environment"))],
  ]);
  const reads: string[] = [];
  const snapshot = createTweakersManagerStatusSnapshot(statusInput(root), {
    now: () => NOW,
    readText(path) {
      reads.push(path);
      const text = files.get(path);
      return text === undefined ? { state: "missing" } : { state: "present", text };
    },
    readDirectory: () => ({ state: "missing" }),
    registeredOfficialSource: () => readyRegisteredOfficialSource(),
  });

  assert.equal(existsSync(root), false);
  assert.equal(snapshot.status.installation.state, "installed");
  assert.equal(snapshot.status.coordinator.state, "active");
  assert.equal(receipt(snapshot, "environment").receiptId, "environment-1");
  assert.equal(reads.includes(paths.environmentTransactionFile), true);
});

test("status reconciles a crash-consumed record only from its matching terminal receipt without reopening it", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  const operationId = "018f0d36-4c08-7a3e-9c1d-123456789abd";
  try {
    const paths = managerStatusPaths(root);
    // This is the receipt chronology captured at prepare time.
    writeFixture(paths.environmentTransactionFile, JSON.stringify(environmentReceipt("before-consume")));
    const store = new ManagerOperationStore(root);
    store.create(consumedEnvironmentCancelRecord(operationId));

    // Simulate a hard kill after `consumed` was fsynced but after the legacy
    // writer made the same receipt terminal, before the manager could replace
    // its own record with `completed`.
    writeFixture(paths.environmentTransactionFile, JSON.stringify(terminalEnvironmentReceipt("environment-1", "cancelled")));
    const beforeStatus = directorySnapshot(root);
    const reconciled = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());

    assert.equal(reconciled.status.operations.state, "valid");
    assert.equal(reconciled.status.operations.activeOperationId, null);
    assert.equal(reconciled.status.operations.preparedCount, 0);
    assert.equal(store.read(operationId)?.phase, "consumed");
    assert.deepEqual(directorySnapshot(root), beforeStatus, "status must not rewrite a consumed record");

    // A matching but non-terminal receipt cannot clear the barrier.  It also
    // proves reconciliation is a projection, never a reopening to prepared.
    writeFixture(paths.environmentTransactionFile, JSON.stringify(environmentReceipt("still-active")));
    const stillBlocked = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());
    assert.equal(stillBlocked.status.operations.activeOperationId, operationId);
    assert.equal(stillBlocked.status.operations.preparedCount, 1);
    assert.equal(store.read(operationId)?.phase, "consumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status exposes active refresh timing detail without source or filesystem bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  const operationId = "018f0d36-4c08-7a3e-9c1d-123456789ab9";
  try {
    const store = new ManagerOperationStore(root);
    store.create({
      ...recoveryRequiredIndependentRefreshRecord(
        operationId,
        "Independent Tweakers refresh failed and the rollback/reopen path was incomplete.",
      ),
      timing: refreshTimingDetail(),
    });

    const snapshot = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());

    assert.deepEqual(snapshot.status.operations.detail, {
      operationId,
      actionId: "refresh.independent",
      phase: "recovery-required",
      timing: refreshTimingDetail(),
    });
    assert.doesNotMatch(JSON.stringify(snapshot.status.operations.detail), /\/Applications|[a-f0-9]{64}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status retains historical desktop-update records for diagnostics without advertising recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  const operationId = "018f0d36-4c08-7a3e-9c1d-123456789abe";
  try {
    const store = new ManagerOperationStore(root);
    store.create(recoveryRequiredDesktopStartRecord(operationId));
    const snapshot = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(snapshot.status.operations.activeOperationId, operationId);
    assert.equal(snapshot.status.operations.detail?.actionId, "desktop-update.start");
    assert.equal(snapshot.actions.some((action) => action.actionId.startsWith("desktop-update.")), false);
    assert.equal(store.read(operationId)?.phase, "recovery-required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("status releases only a proven pre-refresh Tweakers quiescence conflict for a fresh retry", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  const operationId = "018f0d36-4c08-7a3e-9c1d-123456789abf";
  try {
    const paths = managerStatusPaths(root);
    writeFixture(paths.independentStateFile, JSON.stringify({
      version: "1.0.0",
      installedAt: NOW,
      appRoot: "/Applications/Tweakers.app",
      runtimeUpdatedAt: NOW,
    }));
    writeFixture(paths.chatgptAppUpdateReceiptFile, JSON.stringify({
      ...desktopReceipt("official-update-1", "completed"),
      observed: { marketingVersion: "26.901.20858", build: "7658" },
      completedAt: NOW,
      terminalAt: NOW,
    }));
    const store = new ManagerOperationStore(root);
    store.create(recoveryRequiredIndependentRefreshRecord(
      operationId,
      "Exact Tweakers helper quiescence is not proven: 44862",
    ));

    const retryable = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(retryable.status.operations.activeOperationId, null);
    assert.equal(retryable.actions.find((action) => action.actionId === "refresh.independent")?.available, true);
    assert.equal(store.read(operationId)?.phase, "recovery-required", "status must preserve the diagnostic record");

    store.replace(recoveryRequiredIndependentRefreshRecord(
      operationId,
      "Runtime assets not found. Expected at /Users/test/Library/Application Support/Tweakers/managers/com.thomashulihan.tweakers/assets/runtime (built package) or /Users/test/Library/Application Support/Tweakers/runtime/dist (dev).\nRun `npm run build` from the workspace root.",
    ));
    const missingPackagedRuntime = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(missingPackagedRuntime.status.operations.activeOperationId, null);
    assert.equal(missingPackagedRuntime.actions.find((action) => action.actionId === "refresh.independent")?.available, true);

    store.replace(recoveryRequiredIndependentRefreshRecord(
      operationId,
      "loader.cjs not found at /Users/test/Library/Application Support/Tweakers/managers/com.thomashulihan.tweakers/assets/loader.cjs or /Users/test/Library/Application Support/Tweakers/loader/loader.cjs",
    ));
    const missingSealedLoader = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(missingSealedLoader.status.operations.activeOperationId, null);
    assert.equal(missingSealedLoader.actions.find((action) => action.actionId === "refresh.independent")?.available, true);

    store.replace(recoveryRequiredIndependentRefreshRecord(
      operationId,
      "The exact /Applications/Tweakers.app reopen did not produce a new visible main PID with an operation-bound runtime-ready receipt.",
    ));
    const rolledBackLegacyRuntimeReadyTimeout = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(rolledBackLegacyRuntimeReadyTimeout.status.operations.activeOperationId, null);
    assert.equal(rolledBackLegacyRuntimeReadyTimeout.actions.find((action) => action.actionId === "refresh.independent")?.available, true);

    store.replace(recoveryRequiredIndependentRefreshRecord(
      operationId,
      "The exact /Applications/Tweakers.app reopen produced a new visible main PID, but did not publish an operation-bound runtime-ready receipt before the readiness deadline.",
    ));
    const rolledBackRuntimeReadyTimeout = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(rolledBackRuntimeReadyTimeout.status.operations.activeOperationId, null);
    assert.equal(rolledBackRuntimeReadyTimeout.actions.find((action) => action.actionId === "refresh.independent")?.available, true);

    store.replace(recoveryRequiredIndependentRefreshRecord(
      operationId,
      "Tweakers Manager Launcher asset is missing: /Users/test/Library/Application Support/Tweakers/managers/com.thomashulihan.tweakers/generations/assets/manager-launcher/Tweakers Manager Launcher",
    ));
    const redundantManagerRepublish = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(redundantManagerRepublish.status.operations.activeOperationId, null);
    assert.equal(redundantManagerRepublish.actions.find((action) => action.actionId === "refresh.independent")?.available, true);

    store.replace(recoveryRequiredIndependentRefreshRecord(
      operationId,
      "Canonical manager official ChatGPT officialBackendVersion does not match the revalidated app",
    ));
    const clearedBackendEvidence = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(clearedBackendEvidence.status.operations.activeOperationId, null);
    assert.equal(clearedBackendEvidence.actions.find((action) => action.actionId === "refresh.independent")?.available, true);

    store.replace(recoveryRequiredIndependentRefreshRecord(
      operationId,
      "Independent Tweakers refresh failed and the rollback/reopen path was incomplete.",
    ));
    const incompleteRollback = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(incompleteRollback.status.operations.activeOperationId, operationId);

    const journalRoot = join(root, "variants", "tweakers", "transactions", "variant-promotion");
    writeFixture(join(journalRoot, "018f0d36-4c08-7a3e-9c1d-123456789ac0.json"), JSON.stringify({
      id: "018f0d36-4c08-7a3e-9c1d-123456789ac0",
      userRoot: join(root, "variants", "tweakers"),
      target: "/Applications/Tweakers.app",
      phase: "recovered",
    }));
    const recoveredRollback = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(recoveredRollback.status.operations.activeOperationId, null);
    assert.equal(recoveredRollback.actions.find((action) => action.actionId === "refresh.independent")?.available, true);

    writeFixture(join(root, "variants", "tweakers", "runtime-ready.json"), JSON.stringify({
      schemaVersion: 3,
      kind: "tweakers-independent-runtime-ready",
      operationId: "018f0d36-4c08-7a3e-9c1d-123456789ac2",
    }));
    const laterRuntimeReadyReceipt = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(laterRuntimeReadyReceipt.status.operations.activeOperationId, null);
    assert.equal(laterRuntimeReadyReceipt.actions.find((action) => action.actionId === "refresh.independent")?.available, true);

    writeFixture(join(root, "variants", "tweakers", "runtime-ready.json"), JSON.stringify({
      schemaVersion: 3,
      kind: "tweakers-independent-runtime-ready",
      operationId,
    }));
    const matchingRuntimeReadyReceipt = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(matchingRuntimeReadyReceipt.status.operations.activeOperationId, operationId);

    rmSync(join(root, "variants", "tweakers", "runtime-ready.json"));

    writeFixture(join(journalRoot, "018f0d36-4c08-7a3e-9c1d-123456789ac1.json"), JSON.stringify({
      id: "018f0d36-4c08-7a3e-9c1d-123456789ac1",
      userRoot: join(root, "variants", "tweakers"),
      target: "/Applications/Tweakers.app",
      phase: "app:promoted",
    }));
    const anotherInterruptedPromotion = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(anotherInterruptedPromotion.status.operations.activeOperationId, operationId);

    store.replace(recoveryRequiredIndependentRefreshRecord(
      operationId,
      "refresh failed after candidate publication",
    ));
    const ambiguous = createTweakersManagerStatusSnapshot({
      ...statusInput(root),
      enabledActionIds: ["refresh.independent"],
    }, fixedDependencies());
    assert.equal(ambiguous.status.operations.activeOperationId, operationId);
    assert.equal(ambiguous.actions.every((action) => action.available === false), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function statusInput(root: string): { executable: { state: "unresolved"; reason: string }; paths: ManagerStatusPaths } {
  return {
    executable: { state: "unresolved", reason: "descriptor publication is outside T2" },
    paths: managerStatusPaths(root),
  };
}

function fixedDependencies() {
  return {
    now: () => NOW,
    // Status fixtures must not inspect the host's live ChatGPT installation.
    // The fixture models a previously sealed, still-current manager source.
    registeredOfficialSource: () => readyRegisteredOfficialSource(),
  };
}

function readyRegisteredOfficialSource() {
  return {
    state: "ready" as const,
    generationId: "018f0d36-4c08-7a3e-9c1d-123456789abc",
    receiptDigest: "a".repeat(64),
    artifactPath: "/private/tweakers/official-source/generations/018f0d36-4c08-7a3e-9c1d-123456789abc/ChatGPT.app",
    version: "26.831.21537",
    build: "7579",
    candidateDigest: "b".repeat(64),
    sourceDigest: "b".repeat(64),
    revision: `sha256:${"c".repeat(64)}`,
    problem: null,
  };
}

function environmentReceipt(marker: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId: "environment-1",
    phase: "prepared",
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    marker,
  };
}

function terminalEnvironmentReceipt(transactionId: string, phase: "cancelled" | "rolled-back"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId,
    phase,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...(phase === "cancelled" ? { cancelledAt: NOW } : { rolledBackAt: NOW }),
  };
}

function desktopReceipt(transactionId: string, phase: "completed" | "failed"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "desktop-update",
    transactionId,
    phase,
    error: null,
    resumable: false,
    safeOfficialMode: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function consumedEnvironmentCancelRecord(operationId: string): TweakersManagerPreparedOperationV1 {
  return {
    schemaVersion: 1,
    kind: "tweakers-manager-operation",
    managerId: "com.thomashulihan.tweakers",
    protocolVersion: 1,
    operationId,
    preparedRequestId: "018f0d36-4c08-7a3e-9c1d-123456789abc",
    actionId: "environment.cancel",
    moduleIdentity: { state: "resolved", path: "/fixed/Tweakers Manager Launcher", sha256: "a".repeat(64) },
    boundStateToken: `sha256:${"b".repeat(64)}`,
    parameters: {},
    parametersSha256: `sha256:${"c".repeat(64)}`,
    impact: "restart-app",
    createdAt: NOW,
    expiresAt: "2026-08-27T12:05:00.000Z",
    phase: "consumed",
    consumedAt: NOW,
    cancelledAt: null,
    completedAt: null,
    failedAt: null,
    recoveryRequiredAt: null,
    stateTokenInputsSha256: `sha256:${"d".repeat(64)}`,
    receiptChronologyRevision: `sha256:${"e".repeat(64)}`,
    receiptSnapshot: [{
      source: "environment",
      receiptId: "environment-1",
      phase: "prepared",
      revision: `sha256:${"f".repeat(64)}`,
      active: true,
    }],
    receiptRefs: ["environment:environment-1"],
    outcome: null,
    error: null,
  };
}

function recoveryRequiredDesktopStartRecord(operationId: string): TweakersManagerPreparedOperationV1 {
  return {
    schemaVersion: 1,
    kind: "tweakers-manager-operation",
    managerId: "com.thomashulihan.tweakers",
    protocolVersion: 1,
    operationId,
    preparedRequestId: "018f0d36-4c08-7a3e-9c1d-123456789abc",
    actionId: "desktop-update.start",
    moduleIdentity: { state: "resolved", path: "/fixed/Tweakers Manager Launcher", sha256: "a".repeat(64) },
    boundStateToken: `sha256:${"b".repeat(64)}`,
    parameters: {},
    parametersSha256: `sha256:${"c".repeat(64)}`,
    impact: "restart-app",
    createdAt: "2026-08-27T11:59:58.000Z",
    expiresAt: "2026-08-27T12:05:00.000Z",
    phase: "recovery-required",
    consumedAt: NOW,
    cancelledAt: null,
    completedAt: null,
    failedAt: null,
    recoveryRequiredAt: "2026-08-27T12:00:03.000Z",
    stateTokenInputsSha256: `sha256:${"d".repeat(64)}`,
    receiptChronologyRevision: `sha256:${"e".repeat(64)}`,
    receiptSnapshot: [{
      source: "chatgpt-app-update",
      receiptId: null,
      phase: null,
      revision: "missing",
      active: false,
    }],
    receiptRefs: ["chatgpt-app-update:new"],
    outcome: "recovery-required",
    error: "official ChatGPT update did not reach a durable terminal receipt",
  };
}

function recoveryRequiredIndependentRefreshRecord(
  operationId: string,
  error: string,
): TweakersManagerPreparedOperationV1 {
  return {
    ...recoveryRequiredDesktopStartRecord(operationId),
    actionId: "refresh.independent",
    impact: "repair-app",
    receiptRefs: ["independent-tweakers-patch:1.0.0"],
    error,
  };
}

function refreshTimingDetail(): ManagerRefreshTimingEvidenceV1 {
  const unavailable = (reason: string) => ({
    state: "unavailable" as const,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    reason,
  });
  return {
    schemaVersion: 1,
    phases: {
      "source-validation": {
        state: "completed",
        startedAt: "2026-08-27T12:00:00.000Z",
        completedAt: "2026-08-27T12:00:01.000Z",
        durationMs: 31,
        reason: null,
      },
      "apfs-clone": unavailable("The sealed candidate builder does not expose this boundary."),
      "patch-stage": {
        state: "failed",
        startedAt: "2026-08-27T12:00:01.000Z",
        completedAt: "2026-08-27T12:00:02.000Z",
        durationMs: 47,
        reason: null,
      },
      sign: unavailable("The sealed candidate builder does not expose this boundary."),
      verify: unavailable("The sealed candidate builder does not expose this boundary."),
      "quiesce-promote": unavailable("The sealed candidate builder does not expose this boundary."),
      "runtime-ready-wait": unavailable("The sealed candidate builder does not expose this boundary."),
    },
  };
}

function receipt(
  snapshot: ReturnType<typeof createTweakersManagerStatusSnapshot>,
  source: "environment" | "chatgpt-app-update" | "desktop-update" | "environment-mode-cache" | "official-source",
) {
  const result = snapshot.status.receipts.find((candidate) => candidate.source === source);
  assert.ok(result, `expected ${source} receipt`);
  return result;
}

function writeFixture(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function directorySnapshot(root: string): readonly [string, string][] {
  if (!existsSync(root)) return [[".", "missing"]];
  const entries: [string, string][] = [];
  const visit = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryRelative = relative === "." ? entry.name : join(relative, entry.name);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push([entryRelative, "directory"]);
        visit(path, entryRelative);
      } else if (entry.isFile()) {
        entries.push([entryRelative, `file:${readFileSync(path).toString("base64")}`]);
      } else {
        entries.push([entryRelative, "other"]);
      }
    }
  };
  entries.push([".", "directory"]);
  visit(root, ".");
  return entries;
}

function processSnapshot(): { pid: number; ppid: number; argv: readonly string[] } {
  return { pid: process.pid, ppid: process.ppid, argv: [...process.argv] };
}

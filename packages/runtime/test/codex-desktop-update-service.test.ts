import assert from "node:assert/strict";
import test from "node:test";
import {
  createCodexDesktopUpdateService,
  type CodexDesktopUpdateDialog,
  type CodexDesktopUpdateMetadata,
  type CodexDesktopUpdateTarget,
} from "../src/codex-desktop-update-service";

const stableTarget: CodexDesktopUpdateTarget = {
  profile: "stable",
  available: true,
  unavailableReason: null,
};

const currentMetadata: CodexDesktopUpdateMetadata = {
  installed: { marketingVersion: "1.2.3", build: "123" },
  latest: { marketingVersion: "1.2.3", build: "123" },
  checkedAt: "2026-07-16T12:00:00.000Z",
  stale: false,
  error: null,
  updateAvailable: false,
};

test("concurrent menu and Config checks join one metadata request and one native dialog", async () => {
  let releaseMetadata: ((value: CodexDesktopUpdateMetadata) => void) | null = null;
  const metadata = new Promise<CodexDesktopUpdateMetadata>((resolve) => { releaseMetadata = resolve; });
  let refreshes = 0;
  const dialogs: CodexDesktopUpdateDialog[] = [];
  const service = createCodexDesktopUpdateService({
    resolveTarget: async () => stableTarget,
    refreshMetadata: async () => { refreshes += 1; return metadata; },
    showDialog: async (dialog) => { dialogs.push(dialog); return { response: 0 }; },
    startUpdateAndReload: async () => {},
  });

  const menu = service.checkAndPresent();
  const config = service.checkAndPresent();
  assert.equal(menu, config);
  assert.equal(refreshes, 0);

  await Promise.resolve();
  assert.equal(refreshes, 1);
  releaseMetadata!(currentMetadata);
  const [menuResult, configResult] = await Promise.all([menu, config]);

  assert.equal(menuResult, configResult);
  assert.equal(dialogs.length, 1);
  assert.equal(menuResult.status, "current");
});

test("silent checks refresh metadata without ever opening a native dialog", async () => {
  let refreshes = 0;
  let dialogs = 0;
  const service = createCodexDesktopUpdateService({
    resolveTarget: async () => stableTarget,
    refreshMetadata: async () => {
      refreshes += 1;
      return { ...currentMetadata, updateAvailable: true };
    },
    showDialog: async () => { dialogs += 1; return { response: 0 }; },
    startUpdateAndReload: async () => {},
  });

  const result = await service.checkSilently();

  assert.equal(result.status, "update-available");
  assert.equal(refreshes, 1);
  assert.equal(dialogs, 0);
  assert.equal(result.updateAndReloadRequested, false);
});

test("completed checks are retained and published once without sharing mutable state", async () => {
  const published: CodexDesktopUpdateMetadata["latest"][] = [];
  const service = createCodexDesktopUpdateService({
    resolveTarget: async () => stableTarget,
    refreshMetadata: async () => ({
      ...currentMetadata,
      latest: { marketingVersion: "1.3.0", build: "130" },
      updateAvailable: true,
    }),
    showDialog: async () => ({ response: 1 }),
    startUpdateAndReload: async () => {},
    onResult: (result) => {
      published.push(result.latest);
      result.latest.marketingVersion = "mutated publisher copy";
    },
  });

  const result = await service.checkSilently();
  result.latest.build = "mutated caller copy";

  assert.deepEqual(published, [{ marketingVersion: "mutated publisher copy", build: "130" }]);
  assert.deepEqual(service.getSnapshot()?.latest, { marketingVersion: "1.3.0", build: "130" });
});

test("a cached known update remains visible when its metadata refresh is stale", async () => {
  const service = createCodexDesktopUpdateService({
    resolveTarget: async () => stableTarget,
    refreshMetadata: async () => ({
      ...currentMetadata,
      latest: { marketingVersion: "1.3.0", build: "130" },
      updateAvailable: true,
      stale: true,
      error: "OpenAI appcast metadata could not be refreshed.",
    }),
    showDialog: async () => ({ response: 1 }),
    startUpdateAndReload: async () => {},
  });

  const result = await service.checkSilently();

  assert.equal(result.status, "update-available");
  assert.match(result.reason ?? "", /could not be refreshed/);
});

test("a silent check and a manual check share metadata while only the manual check presents", async () => {
  let releaseMetadata: ((value: CodexDesktopUpdateMetadata) => void) | null = null;
  const metadata = new Promise<CodexDesktopUpdateMetadata>((resolve) => { releaseMetadata = resolve; });
  let refreshes = 0;
  let dialogs = 0;
  const service = createCodexDesktopUpdateService({
    resolveTarget: async () => stableTarget,
    refreshMetadata: async () => { refreshes += 1; return metadata; },
    showDialog: async () => { dialogs += 1; return { response: 0 }; },
    startUpdateAndReload: async () => {},
  });

  const silent = service.checkSilently();
  const manual = service.checkAndPresent();
  await Promise.resolve();
  assert.equal(refreshes, 1);
  releaseMetadata!(currentMetadata);

  const [silentResult, manualResult] = await Promise.all([silent, manual]);
  assert.equal(silentResult.status, "current");
  assert.equal(manualResult.status, "current");
  assert.equal(dialogs, 1);
});

test("an available update offers Update and Reload and starts the shared transaction once", async () => {
  const dialogs: CodexDesktopUpdateDialog[] = [];
  let starts = 0;
  const service = createCodexDesktopUpdateService({
    resolveTarget: async () => stableTarget,
    refreshMetadata: async () => ({
      ...currentMetadata,
      latest: { marketingVersion: "1.3.0", build: "130" },
      updateAvailable: true,
    }),
    showDialog: async (dialog) => { dialogs.push(dialog); return { response: 0 }; },
    startUpdateAndReload: async () => { starts += 1; },
  });

  const result = await service.checkAndPresent();

  assert.equal(result.status, "update-available");
  assert.equal(result.updateAndReloadRequested, true);
  assert.equal(starts, 1);
  assert.deepEqual(dialogs[0]?.buttons, ["Update and Reload", "Later"]);
  assert.match(dialogs[0]?.message ?? "", /1\.3\.0/);
  assert.match(dialogs[0]?.detail ?? "", /1\.2\.3/);
});

test("Later leaves an available update actionable without starting a transaction", async () => {
  let starts = 0;
  const service = createCodexDesktopUpdateService({
    resolveTarget: async () => stableTarget,
    refreshMetadata: async () => ({ ...currentMetadata, updateAvailable: true }),
    showDialog: async () => ({ response: 1 }),
    startUpdateAndReload: async () => { starts += 1; },
  });

  const result = await service.checkAndPresent();

  assert.equal(result.status, "update-available");
  assert.equal(result.updateAndReloadRequested, false);
  assert.equal(starts, 0);
});

test("gated Alpha setup is returned inline without opening a dead-end retry dialog", async () => {
  let dialogs = 0;
  let refreshes = 0;
  const service = createCodexDesktopUpdateService({
    resolveTarget: async () => ({
      profile: "alpha",
      available: false,
      unavailableReason: "Launch the registered OpenAI Beta app once to capture its feed.",
      setupRequired: "launch-beta",
    }),
    refreshMetadata: async () => { refreshes += 1; return currentMetadata; },
    showDialog: async () => { dialogs += 1; return { response: 0 }; },
    startUpdateAndReload: async () => {},
  });

  const result = await service.checkAndPresent();

  assert.equal(result.status, "unavailable");
  assert.equal(result.setupRequired, "launch-beta");
  assert.equal(refreshes, 0);
  assert.equal(dialogs, 0);
  assert.equal(result.retryRequested, false);
});

test("a failed update transaction replaces the retained available state and presents the error", async () => {
  const dialogs: CodexDesktopUpdateDialog[] = [];
  const published: string[] = [];
  const service = createCodexDesktopUpdateService({
    resolveTarget: async () => stableTarget,
    refreshMetadata: async () => ({ ...currentMetadata, updateAvailable: true }),
    showDialog: async (dialog) => {
      dialogs.push(dialog);
      return { response: dialogs.length === 1 ? 0 : 1 };
    },
    startUpdateAndReload: async () => { throw new Error("transaction launch failed"); },
    onResult: (result) => { published.push(result.status); },
  });

  const result = await service.checkAndPresent();

  assert.equal(result.status, "error");
  assert.equal(service.getSnapshot()?.status, "error");
  assert.deepEqual(published, ["update-available", "error"]);
  assert.equal(dialogs.length, 2);
  assert.match(dialogs[1]?.detail ?? "", /transaction launch failed/);
});

test("current, stale, error, and unavailable targets have explicit native outcomes", async (t) => {
  const cases: Array<{
    name: string;
    target?: CodexDesktopUpdateTarget;
    metadata?: CodexDesktopUpdateMetadata;
    status: "current" | "stale" | "error" | "unavailable";
    buttons: string[];
  }> = [
    { name: "current", status: "current", metadata: currentMetadata, buttons: ["OK"] },
    {
      name: "stale",
      status: "stale",
      metadata: { ...currentMetadata, stale: true, error: "The authenticated feed could not be refreshed." },
      buttons: ["Try Again", "OK"],
    },
    {
      name: "error",
      status: "error",
      metadata: { ...currentMetadata, error: "The authenticated feed is invalid." },
      buttons: ["Try Again", "OK"],
    },
    {
      name: "alpha unavailable",
      status: "unavailable",
      target: { profile: "alpha", available: false, unavailableReason: "No verified Alpha metadata is available." },
      buttons: ["Try Again", "OK"],
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const dialogs: CodexDesktopUpdateDialog[] = [];
      const service = createCodexDesktopUpdateService({
        resolveTarget: async () => scenario.target ?? stableTarget,
        refreshMetadata: async () => scenario.metadata ?? currentMetadata,
        showDialog: async (dialog) => { dialogs.push(dialog); return { response: scenario.buttons.length - 1 }; },
        startUpdateAndReload: async () => {},
      });

      const result = await service.checkAndPresent();

      assert.equal(result.status, scenario.status);
      assert.deepEqual(dialogs[0]?.buttons, scenario.buttons);
      if (scenario.target?.profile === "alpha") {
        assert.match(dialogs[0]?.detail ?? "", /Alpha \(Pre-release\)/);
        assert.doesNotMatch(dialogs[0]?.detail ?? "", /Stable/);
      }
    });
  }
});

test("Try Again schedules a fresh flight only after the failed flight is complete", async () => {
  const scheduled: Array<() => void> = [];
  let refreshes = 0;
  const service = createCodexDesktopUpdateService({
    resolveTarget: async () => stableTarget,
    refreshMetadata: async () => {
      refreshes += 1;
      return { ...currentMetadata, error: "offline" };
    },
    showDialog: async () => ({ response: 0 }),
    startUpdateAndReload: async () => {},
    scheduleRetry: (retry) => { scheduled.push(retry); },
  });

  const first = await service.checkAndPresent();
  assert.equal(first.retryRequested, true);
  assert.equal(refreshes, 1);
  assert.equal(scheduled.length, 1);

  scheduled[0]!();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshes, 2);
});

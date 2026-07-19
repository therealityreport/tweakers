import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  ConfigCardUpdateCoordinator,
  createEnvironmentConfigController,
  desktopUpdateStatusPresentation,
  restoreEnvironmentFocus,
  type EnvironmentConfigEffects,
  type EnvironmentSelectionPair,
} from "../src/preload/environment-config-controller";

const source = readFileSync(
  resolve(process.cwd(), "packages/runtime/src/preload/settings-injector.ts"),
  "utf8",
);

function functionBody(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source range exists`);
  return source.slice(start, end);
}

interface TestReceipt {
  transactionId: string;
  phase: "prepared";
}

const selectedStableChatGpt: EnvironmentSelectionPair = {
  appExperience: "chatgpt",
  releaseProfile: "stable",
};

function testEnvironmentEffects(
  overrides: Partial<EnvironmentConfigEffects<TestReceipt>> = {},
): EnvironmentConfigEffects<TestReceipt> {
  return {
    prepare: async () => ({ transactionId: "environment-1", phase: "prepared" }),
    confirm: async () => "confirm",
    commit: async () => undefined,
    cancel: async () => undefined,
    ...overrides,
  };
}

test("Desktop Update never presents stale, unavailable, or unchecked state as healthy", () => {
  assert.deepEqual(desktopUpdateStatusPresentation(undefined), { label: "Not checked", tone: "warn" });
  assert.deepEqual(desktopUpdateStatusPresentation("stale"), { label: "Stale", tone: "warn" });
  assert.deepEqual(desktopUpdateStatusPresentation("unavailable"), { label: "Unavailable", tone: "warn" });
  assert.deepEqual(desktopUpdateStatusPresentation("error"), { label: "Error", tone: "error" });
  assert.deepEqual(desktopUpdateStatusPresentation("current"), { label: "Up to date", tone: "ok" });
});

test("Environment stages app experience and release profile independently", () => {
  const controller = createEnvironmentConfigController(selectedStableChatGpt, testEnvironmentEffects());

  controller.stageAppExperience("tweakers");
  assert.deepEqual(controller.snapshot.selected, selectedStableChatGpt);
  assert.deepEqual(controller.snapshot.pending, { appExperience: "tweakers", releaseProfile: "stable" });

  controller.stageReleaseProfile("alpha");
  assert.deepEqual(controller.snapshot.selected, selectedStableChatGpt);
  assert.deepEqual(controller.snapshot.pending, { appExperience: "tweakers", releaseProfile: "alpha" });
  assert.equal(controller.snapshot.hasPendingChanges, true);
});

test("Environment status refresh preserves a newer staged pair", () => {
  const controller = createEnvironmentConfigController(selectedStableChatGpt, testEnvironmentEffects());

  controller.stageAppExperience("tweakers");
  controller.setSelected({ appExperience: "chatgpt", releaseProfile: "alpha" });

  assert.deepEqual(controller.snapshot.selected, {
    appExperience: "chatgpt",
    releaseProfile: "alpha",
  });
  assert.deepEqual(controller.snapshot.pending, {
    appExperience: "tweakers",
    releaseProfile: "stable",
  });
  assert.equal(controller.snapshot.hasPendingChanges, true);
});

test("Environment status refresh follows authoritative state while the form is pristine", () => {
  const controller = createEnvironmentConfigController(selectedStableChatGpt, testEnvironmentEffects());
  const refreshed = { appExperience: "tweakers", releaseProfile: "alpha" } as const;

  controller.setSelected(refreshed);

  assert.deepEqual(controller.snapshot.selected, refreshed);
  assert.deepEqual(controller.snapshot.pending, refreshed);
  assert.equal(controller.snapshot.hasPendingChanges, false);
});

test("Environment prepare failure does not confirm, commit, cancel, or mutate the selection", async () => {
  const calls = { confirm: 0, commit: 0, cancel: 0 };
  const controller = createEnvironmentConfigController(selectedStableChatGpt, testEnvironmentEffects({
    prepare: async () => { throw new Error("candidate signature failed"); },
    confirm: async () => { calls.confirm++; return "confirm"; },
    commit: async () => { calls.commit++; },
    cancel: async () => { calls.cancel++; },
  }));
  controller.stageAppExperience("tweakers");

  const result = await controller.applyAndRestart();

  assert.equal(result.outcome, "prepare-failed");
  assert.deepEqual(calls, { confirm: 0, commit: 0, cancel: 0 });
  assert.deepEqual(controller.snapshot.selected, selectedStableChatGpt);
  assert.deepEqual(controller.snapshot.pending, { appExperience: "tweakers", releaseProfile: "stable" });
  assert.equal(controller.snapshot.busy, false);
  assert.match(controller.snapshot.error ?? "", /candidate signature failed/);
});

test("Environment cancellation records cancel and never invokes the restart coordinator", async () => {
  const calls = { commit: 0, cancel: 0 };
  const controller = createEnvironmentConfigController(selectedStableChatGpt, testEnvironmentEffects({
    confirm: async () => "cancel",
    commit: async () => { calls.commit++; },
    cancel: async () => { calls.cancel++; },
  }));
  controller.stageReleaseProfile("alpha");

  const result = await controller.applyAndRestart();

  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(calls, { commit: 0, cancel: 1 });
  assert.deepEqual(controller.snapshot.selected, selectedStableChatGpt);
  assert.deepEqual(controller.snapshot.pending, selectedStableChatGpt);
  assert.equal(controller.snapshot.hasPendingChanges, false);
});

test("Environment permits one confirmation and one coordinator submission while an apply is active", async () => {
  let resolveDecision!: (decision: "confirm" | "cancel") => void;
  const decision = new Promise<"confirm" | "cancel">((resolveDecisionPromise) => {
    resolveDecision = resolveDecisionPromise;
  });
  const calls = { prepare: 0, confirm: 0, commit: 0 };
  const controller = createEnvironmentConfigController(selectedStableChatGpt, testEnvironmentEffects({
    prepare: async () => {
      calls.prepare++;
      return { transactionId: "environment-1", phase: "prepared" };
    },
    confirm: async () => {
      calls.confirm++;
      return decision;
    },
    commit: async () => { calls.commit++; },
  }));
  controller.stageAppExperience("tweakers");

  const first = controller.applyAndRestart();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const second = await controller.applyAndRestart();
  assert.equal(second.outcome, "busy");

  resolveDecision("confirm");
  assert.equal((await first).outcome, "submitted");
  assert.deepEqual(calls, { prepare: 1, confirm: 1, commit: 1 });
});

test("Environment focus restoration prefers the surviving opener and falls back to the card", () => {
  const focused: string[] = [];
  const opener = { isConnected: true, focus: () => { focused.push("opener"); } };
  const fallback = { isConnected: true, focus: () => { focused.push("fallback"); } };

  assert.equal(restoreEnvironmentFocus(opener, () => fallback), "opener");
  opener.isConnected = false;
  assert.equal(restoreEnvironmentFocus(opener, () => fallback), "fallback");
  assert.deepEqual(focused, ["opener", "fallback"]);
});

test("Config card updates remain independent and reject stale completion", () => {
  const updates = new ConfigCardUpdateCoordinator<string>();
  const environment = updates.begin("environment");
  const desktop = updates.begin("desktop-update");
  const mcp = updates.begin("mcp");
  const watcher = updates.begin("watcher");

  assert.equal(updates.complete(desktop, "update available"), true);
  assert.equal(updates.complete(mcp, "healthy"), true);
  assert.equal(updates.complete(watcher, "repairing"), true);
  const newerEnvironment = updates.begin("environment");
  assert.equal(updates.complete(newerEnvironment, "tweakers-alpha"), true);
  assert.equal(updates.complete(environment, "chatgpt-stable"), false);

  assert.deepEqual(updates.snapshot(), {
    "desktop-update": "update available",
    environment: "tweakers-alpha",
    mcp: "healthy",
    watcher: "repairing",
  });
});

test("Config follows the native structure and keeps operational sections separate", () => {
  const body = functionBody("renderConfigPage", "renderCodexVersionsSection");
  const calls = [
    "renderEnvironmentSection(sectionsWrap, cardUpdates)",
    "renderDesktopUpdateSection(sectionsWrap, cardUpdates)",
    "renderMcpIntegrationSection(sectionsWrap, cardUpdates)",
    "renderAutomaticMaintenanceSection(sectionsWrap, cardUpdates)",
    'sectionTitle("Tweakers Updates")',
    "renderAdvancedRuntimeSection(sectionsWrap)",
    'sectionTitle("Maintenance")',
  ].map((text) => body.indexOf(text));
  assert.ok(calls.every((index) => index >= 0));
  assert.deepEqual([...calls].sort((a, b) => a - b), calls);
  assert.doesNotMatch(source, /function renderModeSection/);
  assert.doesNotMatch(source, /sectionTitle\("App Mode"\)/);
  assert.doesNotMatch(source, /tweaker:switch-app-mode/);
});

test("Environment stages independent selections, prepares before one confirmation, then commits", () => {
  const body = functionBody("renderEnvironmentSection", "environmentChoiceRow");
  assert.match(body, /tweaker:get-environment-status/);
  assert.match(body, /tweaker:get-environment-transaction/);
  assert.match(body, /tweaker:prepare-environment/);
  assert.match(body, /openEnvironmentConfirmModal\(requested/);
  assert.match(body, /tweaker:commit-environment/);
  assert.match(body, /tweaker:cancel-environment/);
  assert.match(body, /transactionId: receipt\.transactionId/);
  assert.match(source, /App Mode & Desktop Release/);
  assert.match(source, /ChatGPT disables every tweak/);
  assert.match(source, /Desktop Release/);
  assert.match(source, /Alpha \(Pre-release\)/);
  assert.match(source, /unavailableReasons/);
  assert.match(body, /environmentSelectionAvailability\(environment/);
  assert.match(body, /appExperience: pending\.appExperience/);
  assert.match(body, /releaseProfile: pending\.releaseProfile/);
  assert.match(body, /!pendingAvailability\.available/);
  const availability = functionBody("environmentSelectionAvailability", "environmentUnavailableReason");
  assert.match(availability, /channel\.availability\?\.\[selection\.appExperience\]/);
  const modal = functionBody("openEnvironmentConfirmModal", "renderDesktopUpdateSection");
  assert.doesNotMatch(modal, /ipcRenderer\.invoke/);
  assert.match(modal, /Cancel/);
  assert.match(modal, /Apply & Restart/);
  assert.match(modal, /Desktop:/);
  assert.match(modal, /Embedded Codex backend:/);
  assert.match(modal, /restore your previously enabled tweaks/);
  assert.match(modal, /last known working environment/);
  assert.match(modal, /aria-describedby/);
  assert.match(modal, /event\.key !== "Tab"/);
});

test("Environment transaction receipts display durable terminal and future phases", () => {
  const body = functionBody("environmentTransactionLabel", "environmentTransactionTone");
  for (const phase of ["completed", "committed", "rolled-back", "failed", "cancelled"]) {
    assert.match(body, new RegExp(phase));
  }
  assert.match(source, /environmentTransactionRow\(receipt, \{/);
  assert.match(source, /humanizeCodexPhase\(phase\)/);
});

test("Environment restores durable requested state and polls receipts until terminal", () => {
  const body = functionBody("renderEnvironmentSection", "environmentChoiceRow");
  assert.match(body, /environmentTransactionRequestedSelection\(transaction\)/);
  assert.match(body, /environmentController\.restorePending\(requested\)/);
  assert.match(body, /environmentTransactionIsTerminal\(transaction\.phase\)/);
  assert.match(body, /scheduleEnvironmentTransactionPoll/);
  assert.match(body, /void loadEnvironmentTransaction\(\)/);
  assert.match(body, /tweaker:get-environment-transaction/);
});

test("Environment offers durable resume, cancel, and safe state-aware recovery actions", () => {
  const body = functionBody("renderEnvironmentSection", "environmentChoiceRow");
  assert.match(body, /openEnvironmentConfirmModal\(requested, receipt/);
  assert.match(body, /tweaker:cancel-environment/);
  assert.match(body, /tweaker:rollback-environment/);
  assert.match(body, /environmentTransactionCanRecover\(receipt\)/);
  assert.match(body, /void loadEnvironmentTransaction\(\)/);
  const row = functionBody("environmentTransactionRow", "environmentTransactionLabel");
  assert.match(row, /Resume\/Confirm/);
  assert.match(row, /Cancel/);
  assert.match(row, /Recover Safely/);
});

test("Environment transaction status surfaces durable helper failure and log detail", () => {
  const detail = functionBody("environmentHelperFailureDetail", "environmentTransactionRow");
  assert.match(detail, /helper\.outcome/);
  assert.match(detail, /helper\.submission/);
  assert.match(detail, /helper\.stderr/);
  assert.match(detail, /helper\.stdout/);
  assert.match(detail, /exitCode/);
  assert.doesNotMatch(detail, /helper\.(?:logs|error)/);
  const row = functionBody("environmentTransactionRow", "environmentTransactionLabel");
  assert.match(row, /environmentHelperFailureDetail\(transaction\)/);
  const inFlight = functionBody("environmentHelperIsInFlight", "environmentTransactionCanRecover");
  assert.match(inFlight, /outcomePhase === "not-started"/);
  assert.match(inFlight, /outcomePhase === "running"/);
  assert.match(inFlight, /outcomePhase === undefined/);
  assert.doesNotMatch(inFlight, /outcomePhase !== "failed"/);
});

test("Desktop Update uses the shared check and durable Update and Reload transaction", () => {
  const body = functionBody("renderDesktopUpdateSection", "renderMcpIntegrationSection");
  assert.match(body, /tweaker:get-codex-desktop-update/);
  assert.match(body, /tweaker:codex-desktop-update-changed/);
  assert.match(body, /ipcRenderer\.on\(/);
  assert.match(body, /ipcRenderer\.removeListener\(/);
  assert.match(body, /initialResultSuperseded/);
  assert.match(body, /nextTime < currentTime/);
  assert.match(body, /Check for Updates…/);
  assert.match(body, /tweaker:check-codex-desktop-update/);
  assert.match(body, /Update and Reload/);
  assert.match(body, /tweaker:start-codex-desktop-update/);
  assert.match(body, /tweaker:get-codex-desktop-update-transaction/);
  assert.match(body, /tweaker:resume-codex-desktop-update/);
  assert.match(body, /tweaker:cancel-codex-desktop-update/);
  assert.match(body, /void loadTransaction\(\)/);
  assert.match(body, /scheduleTransactionPoll/);
  assert.match(body, /transactionPollFailures \+= 1/);
  assert.match(body, /Math\.min\(30_000/);
  assert.match(body, /scheduleTransactionPoll\(backoff \+ jitter\)/);
  assert.match(body, /transactionPollFailures = 0/);
  assert.match(body, /awaitingTransactionReceiptUntil = Date\.now\(\) \+ 10_000/);
  assert.match(body, /did not create a transaction receipt/);
  assert.doesNotMatch(source, /tweaker:install-codex-desktop-update/);
});

test("Desktop Update explains gated Alpha setup inline and disables its dead-end check", () => {
  const body = functionBody("renderDesktopUpdateSection", "renderMcpIntegrationSection");
  assert.match(body, /result\?\.setupRequired/);
  assert.match(body, /Register OpenAI Beta/);
  assert.match(body, /Launch OpenAI Beta once/);
  assert.match(body, /check\.disabled = busy \|\| !!result\?\.setupRequired/);
  assert.match(body, /Alpha update checks stay disabled/);
});

test("MCP and automatic maintenance expose health and repair actions separately", () => {
  const mcp = functionBody("renderMcpIntegrationSection", "renderAutomaticMaintenanceSection");
  assert.match(mcp, /tweaker:get-mcp-sync-state/);
  assert.match(mcp, /tweaker:repair-mcp/);
  const maintenance = functionBody("renderAutomaticMaintenanceSection", "renderAdvancedRuntimeSection");
  assert.match(maintenance, /tweaker:get-watcher-health/);
  assert.match(source, /tweaker:repair-auto-maintenance/);
  assert.doesNotMatch(source, /sectionTitle\("Auto-Repair Watcher"\)/);
});

test("MCP health stays live while Config is mounted and removes its subscription", () => {
  const mcp = functionBody("renderMcpIntegrationSection", "renderAutomaticMaintenanceSection");
  assert.match(mcp, /tweaker:mcp-sync-state-changed/);
  assert.match(mcp, /ipcRenderer\.on\(/);
  assert.match(mcp, /ipcRenderer\.removeListener\(/);
  assert.match(mcp, /card\.isConnected/);
});

test("Automatic Maintenance waits for a newer completed watcher cycle", () => {
  const maintenance = functionBody("renderAutomaticMaintenanceSection", "renderAdvancedRuntimeSection");
  assert.match(source, /Repair Now/);
  assert.match(maintenance, /Automatic maintenance running/);
  assert.match(maintenance, /Automatic maintenance succeeded/);
  assert.match(maintenance, /latestCompletedCycle/);
  assert.match(maintenance, /MAX_REPAIR_POLLS/);
  assert.match(maintenance, /cycle\.completedAt > repairBaselineCycle\.completedAt/);
  assert.match(maintenance, /Automatic maintenance failed/);
});

test("Environment confirmation restores focus to a surviving control", () => {
  const modal = functionBody("openEnvironmentConfirmModal", "renderDesktopUpdateSection");
  assert.match(modal, /document\.activeElement/);
  assert.match(modal, /data-tweaker-environment-card/);
  assert.match(modal, /requestAnimationFrame\(restoreFocus\)/);
});

test("Environment offers native Beta registration when Alpha is unavailable", () => {
  const body = functionBody("renderEnvironmentSection", "environmentChoiceRow");
  assert.match(body, /Choose Beta App…/);
  assert.match(body, /tweaker:choose-alpha-environment/);
  assert.doesNotMatch(body, /appPath|app-path/);
});

test("Runtime Versions keeps active, stable, and alpha backend truth visible", () => {
  const body = functionBody("renderCodexVersionsSection", "renderCodexVersionsCard");
  const caller = functionBody("renderAdvancedRuntimeSection", "renderCodexVersionsSection");
  assert.match(body, /Runtime Versions/);
  assert.match(caller, /renderCodexVersionsSection\(sectionsWrap\)/);
  assert.doesNotMatch(caller, /collapsed:\s*true/);
  assert.match(source, /Active Codex backend/);
  assert.match(source, /Desktop-Embedded Codex CLI/);
  assert.match(source, /Latest Stable CLI Release/);
  assert.match(source, /Managed Alpha CLI \(Pre-release\)/);
  assert.match(source, /Desktop profile and CLI release channel are reported separately/);
  assert.doesNotMatch(source, /Stable CLI \(Bundled\)/);
  assert.doesNotMatch(source, /CODEX \(UPDATE AVAILABLE\)/);
});

test("Runtime reporting separates the measured active backend from selected and available lanes", () => {
  const active = functionBody("codexActiveCliRow", "codexCliRow");
  const embedded = functionBody("codexEmbeddedCliRow", "codexLatestStableReleaseRow");
  const selected = functionBody("codexRuntimeRow", "codexFeatureBrowser");
  assert.match(active, /snapshot\.activeCli/);
  assert.match(active, /Version \$\{version\}/);
  assert.match(active, /codexVersionChannelLabel\(active\.versionChannel\)/);
  assert.match(active, /active\.path/);
  assert.match(active, /external CODEX_CLI_PATH override/);
  assert.match(embedded, /cli\.available \? null : cli\.error/);
  assert.match(selected, /Selected:/);
  assert.match(selected, /Active:/);
  assert.match(selected, /snapshot\.activeCli\.version/);
});

test("Advanced Runtime displays the effective CLI lane without bypassing Environment", () => {
  const body = functionBody("codexRuntimeRow", "codexFeatureBrowser");
  assert.match(body, /Managed by Environment/);
  assert.doesNotMatch(body, /document\.createElement\("button"\)/);
  assert.doesNotMatch(body, /runCodexAction|window\.confirm|ipcRenderer\.invoke/);
  assert.doesNotMatch(source, /tweaker:set-codex-cli-lane/);
});

test("Codex section paints cache first, refreshes stale data, and polls operations", () => {
  const body = functionBody("renderCodexVersionsSection", "renderCodexVersionsCard");
  assert.match(body, /tweaker:get-codex-versions/);
  assert.match(body, /tweaker:refresh-codex-versions/);
  assert.match(body, /isCodexSnapshotStale\(snapshot\)/);
  assert.match(body, /codexProgressBusy\(snapshot\.installProgress\)/);
  assert.match(body, /actionInFlight/);
  assert.match(body, /card\.isConnected/);
});

test("install and rollback start polling before their IPC operation settles", () => {
  const action = functionBody("runCodexAction", "safeUiError");
  const start = action.indexOf('reload("operation-start")');
  const invoke = action.indexOf("ipcRenderer.invoke(channel");
  const stop = action.indexOf('reload("operation-stop")');
  assert.ok(start >= 0 && invoke > start, "polling starts before invoking the long-running action");
  assert.ok(stop > invoke, "polling stops only from the terminal finally path");
  assert.match(source, /tweaker:install-codex-beta/);
  assert.match(source, /tweaker:rollback-codex-beta/);
});

test("renderer consumes the canonical Codex snapshot instead of speculative aliases", () => {
  assert.match(source, /CodexVersionsSnapshot,/);
  assert.match(source, /snapshot\.activeCli/);
  assert.match(source, /snapshot\.cli\.bundled/);
  assert.match(source, /snapshot\.cli\.beta/);
  assert.match(source, /feature\.stages\[lane\]/);
  assert.match(source, /feature\.enabled\[lane\]/);
  assert.doesNotMatch(source, /CodexVersionsSnapshotView|featureUnion|bundledCli|betaCli|fallbackError/);
});

test("Codex UI exposes only the approved runtime and update IPC actions", () => {
  for (const channel of [
    "tweaker:install-codex-beta",
    "tweaker:rollback-codex-beta",
    "tweaker:set-codex-feature",
    "tweaker:check-codex-desktop-update",
    "tweaker:start-codex-desktop-update",
    "tweaker:get-codex-desktop-update-transaction",
    "tweaker:resume-codex-desktop-update",
    "tweaker:cancel-codex-desktop-update",
  ]) assert.match(source, new RegExp(channel));
  assert.doesNotMatch(source, /tweaker:set-codex-cli-lane/);
  assert.match(source, /\{ lane, name: feature\.name, enabled: next \}/);
  assert.doesNotMatch(source, /tweaker:(?:install-codex-beta|rollback-codex-beta)[^\n]*\{[^}]*url/);
});

test("feature browser is collapsed, searchable, filtered, and keeps retired stages read only", () => {
  const body = functionBody("codexFeatureBrowser", "codexFeatureRow");
  assert.match(body, /document\.createElement\("details"\)/);
  assert.match(body, /Search Codex features/);
  assert.match(body, /"deprecated", "removed"/);
  assert.match(body, /"bundled-only", "beta-only"/);
  assert.match(source, /stage !== "deprecated"/);
  assert.match(source, /stage !== "removed"/);
  assert.match(source, /Feature changes apply to new sessions/);
});

test("external release links are limited to official OpenAI Codex GitHub paths", () => {
  const body = functionBody("isSafeCodexGithubUrl", "openCodexGithubUrl");
  assert.match(body, /parsed\.protocol === "https:"/);
  assert.match(body, /parsed\.hostname === "github\.com"/);
  assert.match(body, /\/openai\/codex/);
});

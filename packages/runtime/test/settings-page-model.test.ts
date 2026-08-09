import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSettingsNavigationModel,
  hasNativeSettingsSidebarOwnership,
  isNativeSettingsSidebarEvidence,
  type SettingsSidebarEvidence,
} from "../src/preload/settings-page-model";

const canonical = [
  ["co.tweakers.account-switcher", "Accounts"],
  ["co.tweakers.appshots", "AppShots"],
  ["co.tweakers.developer-tools", "Developer Tools"],
  ["co.tweakers.projects", "Projects"],
  ["co.tweakers.shadcn-codex-ui", "Shadcn Codex UI"],
  ["co.tweakers.thread-summary-profiles", "Thread Summary Profiles"],
  ["co.tweakers.followup", "Codex Follow-up"],
  ["co.tweakers.titlebar-controls", "Titlebar Controls"],
  ["co.tweakers.ui-improvements", "UI Improvements"],
  ["co.tweakers.usage-limit-resets-tracker", "Usage Limit Resets Tracker"],
  ["co.tweakers.user-questions", "User Questions"],
] as const;

function tweak(id: string, name: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    name,
    version: "1.0.0",
    description: `${name} description`,
    enabled: true,
    status: "enabled",
    ...patch,
  };
}

function sidebarEvidence(patch: Partial<SettingsSidebarEvidence> = {}): SettingsSidebarEvidence {
  return {
    width: 360,
    height: 900,
    left: 120,
    viewportWidth: 1600,
    forbiddenSurface: false,
    nativePanelSlugCount: 8,
    coreLabelCount: 4,
    totalLabelCount: 9,
    mainAppLabelCount: 0,
    settingsOnlyLabelCount: 4,
    ...patch,
  };
}

test("native Settings ownership requires a panel-slug marker and rejects forbidden surfaces", () => {
  assert.equal(hasNativeSettingsSidebarOwnership(sidebarEvidence()), true);
  assert.equal(hasNativeSettingsSidebarOwnership(sidebarEvidence({ nativePanelSlugCount: 1 })), true);
  assert.equal(hasNativeSettingsSidebarOwnership(sidebarEvidence({ nativePanelSlugCount: 0 })), false);
  assert.equal(hasNativeSettingsSidebarOwnership(sidebarEvidence({ forbiddenSurface: true })), false);
});

test("thread and Plan surfaces cannot qualify from settings-like words and geometry", () => {
  assert.equal(isNativeSettingsSidebarEvidence(sidebarEvidence({
    width: 608,
    left: 390,
    nativePanelSlugCount: 0,
    coreLabelCount: 4,
    totalLabelCount: 7,
  })), false);
});

test("native Settings evidence keeps geometry and main-navigation guards", () => {
  assert.equal(isNativeSettingsSidebarEvidence(sidebarEvidence()), true);
  assert.equal(isNativeSettingsSidebarEvidence(sidebarEvidence({ nativePanelSlugCount: 1 })), false);
  assert.equal(isNativeSettingsSidebarEvidence(sidebarEvidence({ width: 700 })), false);
  assert.equal(isNativeSettingsSidebarEvidence(sidebarEvidence({
    mainAppLabelCount: 2,
    settingsOnlyLabelCount: 0,
  })), false);
});

test("eleven enabled Tweakers produce eleven unique alphabetical settings rows", () => {
  const tweaks = canonical.map(([id, name]) => tweak(id, name));
  const registrations = [
    { id: "developer", tweakId: canonical[1][0], title: "Developer Tools" },
    { id: "accounts", tweakId: canonical[0][0], title: "Accounts" },
    { id: "projects", tweakId: canonical[2][0], title: "Projects" },
  ];
  const rows = buildSettingsNavigationModel(tweaks, registrations);
  assert.equal(rows.length, 11);
  assert.equal(new Set(rows.map((row) => row.tweakId)).size, 11);
  assert.deepEqual(rows.map((row) => row.title), [...rows.map((row) => row.title)].sort((a, b) => a.localeCompare(b)));
  assert.equal(rows.find((row) => row.tweakId === canonical[0][0])?.fallback, false);
  assert.equal(rows.find((row) => row.tweakId === canonical[3][0])?.fallback, true);
});

test("multiple registrations become sections under one tweak row", () => {
  const rows = buildSettingsNavigationModel(
    [tweak("co.example.multi", "Multi")],
    [
      { id: "general", tweakId: "co.example.multi", title: "General" },
      { id: "advanced", tweakId: "co.example.multi", title: "Advanced" },
    ],
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].registrationIds, ["general", "advanced"]);
  assert.equal(rows[0].fallback, false);
});

test("disabled tweaks disappear while failed and quarantined enabled tweaks retain fallback rows", () => {
  const rows = buildSettingsNavigationModel([
    tweak("co.example.disabled", "Disabled", { enabled: false, status: "disabled" }),
    tweak("co.example.failed", "Failed", { status: "failed", healthError: "boom" }),
    tweak("co.example.quarantined", "Quarantined", { status: "quarantined", healthError: "stopped" }),
  ], []);
  assert.deepEqual(rows.map((row) => row.tweakId), ["co.example.failed", "co.example.quarantined"]);
  assert.equal(rows[0].lifecycle, "failed");
  assert.equal(rows[0].warning, "boom");
  assert.equal(rows[1].lifecycle, "quarantined");
});

test("renderer lifecycle overrides win over the reported catalog status", () => {
  const rows = buildSettingsNavigationModel([
    tweak("co.example.overridden", "Overridden", { status: "enabled", lifecycleOverride: "failed" }),
    tweak("co.example.plain", "Plain", { status: "enabled" }),
  ], []);
  assert.equal(rows.find((row) => row.tweakId === "co.example.overridden")?.lifecycle, "failed");
  assert.equal(rows.find((row) => row.tweakId === "co.example.plain")?.lifecycle, "enabled");
});

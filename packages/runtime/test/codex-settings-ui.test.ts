import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

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

test("Config renders CODEX directly above App Mode and before existing sections", () => {
  const body = functionBody("renderConfigPage", "renderCodexVersionsSection");
  const calls = [
    "renderCodexVersionsSection(sectionsWrap)",
    "renderModeSection(sectionsWrap)",
    'sectionTitle("Tweakers Updates")',
    'sectionTitle("Auto-Repair Watcher")',
    'sectionTitle("Maintenance")',
  ].map((text) => body.indexOf(text));
  assert.ok(calls.every((index) => index >= 0));
  assert.deepEqual([...calls].sort((a, b) => a - b), calls);
});

test("Codex section paints cache first, refreshes stale data, and polls operations", () => {
  const body = functionBody("renderCodexVersionsSection", "renderCodexVersionsCard");
  assert.match(body, /codexpp:get-codex-versions/);
  assert.match(body, /codexpp:refresh-codex-versions/);
  assert.match(body, /isCodexSnapshotStale\(snapshot\)/);
  assert.match(body, /codexProgressBusy\(snapshot\.installProgress\)/);
  assert.match(body, /actionInFlight/);
  assert.match(body, /card\.isConnected/);
  assert.match(body, /CODEX \(UPDATE AVAILABLE\)/);
});

test("install and rollback start polling before their IPC operation settles", () => {
  const action = functionBody("runCodexAction", "safeUiError");
  const start = action.indexOf('reload("operation-start")');
  const invoke = action.indexOf("ipcRenderer.invoke(channel");
  const stop = action.indexOf('reload("operation-stop")');
  assert.ok(start >= 0 && invoke > start, "polling starts before invoking the long-running action");
  assert.ok(stop > invoke, "polling stops only from the terminal finally path");
  assert.match(source, /codexpp:install-codex-beta/);
  assert.match(source, /codexpp:rollback-codex-beta/);
});

test("renderer consumes the canonical Codex snapshot instead of speculative aliases", () => {
  assert.match(source, /CodexVersionsSnapshot,/);
  assert.match(source, /snapshot\.cli\.bundled/);
  assert.match(source, /snapshot\.cli\.beta/);
  assert.match(source, /feature\.stages\[lane\]/);
  assert.match(source, /feature\.enabled\[lane\]/);
  assert.doesNotMatch(source, /CodexVersionsSnapshotView|featureUnion|bundledCli|betaCli|fallbackError/);
});

test("Codex UI exposes only the approved runtime and update IPC actions", () => {
  for (const channel of [
    "codexpp:set-codex-cli-lane",
    "codexpp:install-codex-beta",
    "codexpp:rollback-codex-beta",
    "codexpp:set-codex-feature",
    "codexpp:check-codex-desktop-update",
    "codexpp:install-codex-desktop-update",
  ]) assert.match(source, new RegExp(channel));
  assert.match(source, /\{ lane, confirmOverride \}/);
  assert.match(source, /\{ lane, name: feature\.name, enabled: next \}/);
  assert.doesNotMatch(source, /codexpp:(?:install-codex-beta|rollback-codex-beta)[^\n]*\{[^}]*url/);
});

test("desktop appcast checks stay enabled independently of native install readiness", () => {
  const body = functionBody("codexDesktopRow", "codexCliRow");
  assert.match(body, /check\.disabled = busy/);
  assert.doesNotMatch(body, /check\.disabled = busy \|\| nativeUnavailable/);
  assert.match(body, /install\.disabled = busy \|\| nativeUnavailable \|\| !desktop\.nativeUpdateActionable/);
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

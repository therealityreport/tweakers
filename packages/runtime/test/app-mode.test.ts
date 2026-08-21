import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  appModeLabel,
  parseSwitchAppModePayload,
  switchAppMode,
  type SwitchAppModeDeps,
} from "../src/app-mode";

function deps(overrides: Partial<SwitchAppModeDeps> = {}): SwitchAppModeDeps & {
  calls: { cli: string; args: string[] }[];
} {
  const calls: { cli: string; args: string[] }[] = [];
  return {
    calls,
    currentMode: "tweakers",
    resolveCli: () => "/managed-runtime/current/packages/installer/dist/cli.js",
    cliExists: () => true,
    startCliWithLaunchd: (cli, args) => {
      calls.push({ cli, args });
      return true;
    },
    ...overrides,
  };
}

test("switch-app-mode accepts only { target: chatgpt | tweaker }", () => {
  assert.equal(parseSwitchAppModePayload({ target: "chatgpt" }), "chatgpt");
  assert.equal(parseSwitchAppModePayload({ target: "tweakers" }), "tweakers");
  for (const payload of [
    undefined,
    null,
    "chatgpt",
    ["chatgpt"],
    {},
    { target: "vanilla" },
    { target: "chatgpt", extra: true },
    { mode: "chatgpt" },
  ]) {
    assert.equal(parseSwitchAppModePayload(payload), null, JSON.stringify(payload) ?? "undefined");
    const d = deps();
    const result = switchAppMode(payload, d);
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /Invalid app mode request/);
    assert.equal(d.calls.length, 0);
  }
});

test("switch-app-mode refuses a target equal to the current mode", () => {
  const d = deps();
  const result = switchAppMode({ target: "tweakers" }, d);
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /already in Tweakers mode/);
  assert.equal(d.calls.length, 0);
});

test("switch-app-mode hands off to the installer CLI via the launchd seam with mode <target> --yes", () => {
  const d = deps();
  const result = switchAppMode({ target: "chatgpt" }, d);
  assert.equal(result.ok, true);
  assert.deepEqual(d.calls, [{
    cli: "/managed-runtime/current/packages/installer/dist/cli.js",
    args: ["mode", "chatgpt", "--yes"],
  }]);
});

test("switch-app-mode validates the other direction symmetrically", () => {
  const d = deps({ currentMode: "chatgpt" });
  const result = switchAppMode({ target: "tweakers" }, d);
  assert.equal(result.ok, true);
  assert.deepEqual(d.calls[0]?.args, ["mode", "tweakers", "--yes"]);
});

test("switch-app-mode fails cleanly when the CLI is missing or launchd submission fails", () => {
  const missing = deps({ cliExists: () => false });
  const missingResult = switchAppMode({ target: "chatgpt" }, missing);
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.message ?? "", /installer CLI is unavailable/);
  assert.equal(missing.calls.length, 0);

  const failed = deps({ startCliWithLaunchd: () => false });
  const failedResult = switchAppMode({ target: "chatgpt" }, failed);
  assert.equal(failedResult.ok, false);
  assert.match(failedResult.message ?? "", /mode-switch helper/);
});

test("app mode labels match the user-facing vocabulary", () => {
  assert.equal(appModeLabel("chatgpt"), "ChatGPT App");
  assert.equal(appModeLabel("tweakers"), "Tweakers");
});

// ── main.ts / preload wiring (source contracts, matching the conventions in
//    codex-main-integration.test.ts) ──────────────────────────────────────

const mainSource = readFileSync(resolve("packages/runtime/src/main.ts"), "utf8");
const injectorSource = readFileSync(resolve("packages/runtime/src/preload/settings-injector.ts"), "utf8");
const hostSource = readFileSync(resolve("packages/runtime/src/preload/tweak-host.ts"), "utf8");
const pageModelSource = readFileSync(resolve("packages/runtime/src/preload/settings-page-model.ts"), "utf8");

test("main removes legacy mode/lane IPC and routes restarts through Environment", () => {
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("tweaker:switch-app-mode"/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("tweaker:set-codex-cli-lane"/);
  assert.match(mainSource, /ipcMain\.handle\("tweaker:prepare-environment"/);
  assert.match(mainSource, /ipcMain\.handle\("tweaker:commit-environment"/);
  assert.match(mainSource, /ipcMain\.handle\("tweaker:rollback-environment"/);
  assert.match(mainSource, /ipcMain\.handle\("tweaker:recover-environment"/);
});

test("the runtime carries no soft vanilla mode or mode-switcher special cases", () => {
  for (const [name, source] of [
    ["main.ts", mainSource],
    ["settings-injector.ts", injectorSource],
    ["tweak-host.ts", hostSource],
    ["settings-page-model.ts", pageModelSource],
  ] as const) {
    assert.doesNotMatch(source, /MODE_SWITCHER_ID|__tweakersModeControl|readTweakersMode|isTweakLoadAllowed/, name);
    assert.doesNotMatch(source, /"vanilla"|'vanilla'/, name);
  }
  // The one sanctioned remnant: the startup cleanup of the retired tweak's
  // persisted modeState.
  assert.match(mainSource, /removeLegacyModeSwitcherState\(userRoot\)/);
});

test("the Environment control prepares one paired selection before one confirmation", () => {
  const section = extractFunctionBody(injectorSource, "renderEnvironmentSection");
  const modal = extractFunctionBody(injectorSource, "openEnvironmentConfirmModal");
  assert.match(section, /tweaker:prepare-environment/);
  assert.match(section, /openEnvironmentConfirmModal\(requested, receipt/);
  assert.match(modal, /Apply & Restart/);
  assert.doesNotMatch(injectorSource, /tweaker:switch-app-mode/);
  assert.doesNotMatch(injectorSource, /tweaker:set-codex-cli-lane/);
});

test("the Environment control follows the durable receipt instead of parking on helper submission", () => {
  const section = extractFunctionBody(injectorSource, "renderEnvironmentSection");
  assert.match(section, /scheduleEnvironmentTransactionPoll/);
  assert.match(section, /loadEnvironmentTransaction/);
  assert.match(section, /normalizeEnvironmentHelperSubmission/);
  assert.match(section, /environmentTransactionIsTerminal/);
  assert.match(section, /approvalAt: new Date\(\)\.toISOString\(\)/);
  const terminal = extractFunctionBody(injectorSource, "environmentTransactionIsTerminal");
  assert.match(terminal, /ready/);
  assert.match(terminal, /stale_requires_prepare/);
  const recoverable = extractFunctionBody(injectorSource, "environmentTransactionCanRecover");
  assert.match(recoverable, /schemaVersion === 2/);
  const diagnostics = extractFunctionBody(mainSource, "attachEnvironmentHelperDiagnostics");
  assert.match(diagnostics, /environment-cache/);
  assert.match(diagnostics, /generations/);
  assert.match(diagnostics, /submission === null && outcome === null/);
});

test("the Environment modal is accessible and traps keyboard focus", () => {
  const modal = extractFunctionBody(injectorSource, "openEnvironmentConfirmModal");
  assert.match(modal, /aria-modal/);
  assert.match(modal, /aria-labelledby/);
  assert.match(modal, /event\.key === "Escape"/);
  assert.match(modal, /event\.key !== "Tab"/);
  assert.match(modal, /confirm\.focus\(\)/);
});

function extractHandlerBody(source: string, channel: string): string {
  const markerIndex = source.indexOf(`"${channel}"`);
  assert.notEqual(markerIndex, -1, `missing IPC handler: ${channel}`);
  const arrowIndex = source.indexOf("=>", markerIndex);
  return extractBlock(source, source.indexOf("{", arrowIndex));
}

function extractFunctionBody(source: string, name: string): string {
  const markerIndex = source.indexOf(`function ${name}`);
  assert.notEqual(markerIndex, -1, `missing function: ${name}`);
  return extractBlock(source, source.indexOf("{", markerIndex));
}

function extractBlock(source: string, openingBrace: number): string {
  assert.notEqual(openingBrace, -1, "missing opening brace");
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  assert.fail("missing closing brace");
}

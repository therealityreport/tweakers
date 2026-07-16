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

test("switch-app-mode accepts only { target: chatgpt | tweakers }", () => {
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

test("main registers codexpp:switch-app-mode beside start-local-refresh on the launchd path", () => {
  const refresh = mainSource.indexOf('ipcMain.handle("codexpp:start-local-refresh"');
  const switchMode = mainSource.indexOf('ipcMain.handle("codexpp:switch-app-mode"');
  assert.ok(refresh >= 0 && switchMode > refresh, "switch-app-mode is registered after start-local-refresh");
  const body = extractHandlerBody(mainSource, "codexpp:switch-app-mode");
  assert.match(body, /switchAppMode\(payload/);
  assert.match(body, /startCliWithLaunchd: startInstalledCliWithLaunchd/);
  assert.match(body, /localRefreshCli\(\)/);
  assert.doesNotMatch(body, /startInstalledCli\(|spawn\(|confirm|dialog/i);
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

test("the App Mode control confirms in the renderer, then invokes the switch IPC", () => {
  const section = extractFunctionBody(injectorSource, "renderModeSection");
  assert.match(section, /openModeSwitchModal\(target/);
  const modal = extractFunctionBody(injectorSource, "openModeSwitchModal");
  assert.doesNotMatch(modal, /window\.confirm/);
  assert.match(injectorSource, /codexpp:switch-app-mode/);
  assert.match(injectorSource, /ChatGPT will quit and restart as the official app\. Tweaks turn off; the Chrome-extension bridge turns on; some macOS permissions may need re-granting\./);
  assert.match(injectorSource, /ChatGPT will quit and restart with Tweakers enabled\. Tweaks turn on; the Chrome-extension bridge turns off; some macOS permissions may need re-granting\./);
});

test("the App Mode control never parks in Restarting… forever after a submitted switch", () => {
  const section = extractFunctionBody(injectorSource, "renderModeSection");
  // ok:true only means the launchd helper was submitted; a pre-quit CLI
  // refusal is otherwise invisible (stdio discarded), so the control arms a
  // timeout that re-enables it and points at the switcher / mode status.
  assert.match(section, /MODE_SWITCH_START_TIMEOUT_MS/);
  assert.match(section, /clearSwitchStartTimer/);
  assert.match(section, /The switch did not start — check the Tweakers menu-bar switcher or run `tweakers mode status`\./);
  assert.match(section, /pagehide/);
});

test("the mode modal ignores backdrop clicks born from a double-click on the trigger", () => {
  const modal = extractFunctionBody(injectorSource, "openModeSwitchModal");
  // Dismissal requires the press to BEGIN on the backdrop and to fall outside
  // the open grace period (a double-click's second click lands on the overlay
  // that just appeared over the trigger button).
  assert.match(modal, /pressBeganOnOverlay/);
  assert.match(modal, /mousedown/);
  assert.match(modal, /openedAt/);
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

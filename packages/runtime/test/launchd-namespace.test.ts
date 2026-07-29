import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const mainSource = readFileSync(resolve("packages/runtime/src/main.ts"), "utf8");

test("launchd patch helpers use the unified namespace and self-remove", () => {
  assert.doesNotMatch(mainSource, /com\.tweaker/);
  assert.match(mainSource, /com\.therealityreport\.tweakers\.patch-helper\./);

  const helperBody = extractFunctionBody(mainSource, "startInstalledCliWithLaunchd");
  assert.match(helperBody, /trap/);
  // Self-removal is bootout + plist cleanup: the helper is a bootstrapped gui
  // domain service, never an app-attributed `launchctl submit` one-shot job —
  // Dock quit-support unloads those when the submitting app terminates, which
  // once killed a coordinator mid-commit the moment it quit the app.
  assert.match(helperBody, /launchctl bootout gui/);
  assert.match(helperBody, /"bootstrap"/);
  assert.doesNotMatch(helperBody, /"submit"/);
});

test("launchctl bootstrap is reserved for installer CLI helpers", () => {
  const helperStart = mainSource.indexOf("function startInstalledCliWithLaunchd");
  assert.notEqual(helperStart, -1, "missing launchd helper");
  const helperBody = extractFunctionBody(mainSource, "startInstalledCliWithLaunchd");
  const helperBodyStart = mainSource.indexOf("{", helperStart) + 1;
  const helperEnd = helperBodyStart + helperBody.length;
  // Assert on the actual invocation (`spawnSync("launchctl", ...)`), not a
  // literal phrase — launchctl also appears in comments and log messages,
  // which are documentation, not a second bootstrap site.
  const submitIndexes = [...mainSource.matchAll(/spawnSync\(\s*"launchctl"/g)].map((match) => match.index ?? -1);

  assert.equal(submitIndexes.length, 1, "unexpected launchctl invocation outside the installer helper");
  assert.ok(submitIndexes[0] >= helperStart && submitIndexes[0] < helperEnd, "launchctl bootstrap must stay in the installer helper");

  const callers = [...mainSource.matchAll(/startInstalledCli\(([^;]*?)\);/g)].map((match) => match[1]);
  assert.ok(callers.length >= 2, "expected at least the update + refresh-local installer CLI helper callers");
  assert.ok(callers.some((caller) => /\["update",\s*"--watcher"\]/.test(caller)));
  assert.ok(callers.some((caller) => /\["refresh-local",/.test(caller)));
  for (const caller of callers) {
    assert.doesNotMatch(caller, /app\.relaunch|process\.execPath/);
  }
});

function extractFunctionBody(source: string, name: string): string {
  const markerIndex = source.indexOf(`function ${name}`);
  assert.notEqual(markerIndex, -1, `missing function: ${name}`);
  const openingBrace = source.indexOf("{", markerIndex);
  assert.notEqual(openingBrace, -1, `missing opening brace for ${name}`);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  assert.fail(`missing closing brace for ${name}`);
}

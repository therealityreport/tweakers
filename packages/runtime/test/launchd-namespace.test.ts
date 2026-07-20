import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const mainSource = readFileSync(resolve("packages/runtime/src/main.ts"), "utf8");
const launchSource = readFileSync(resolve("packages/runtime/src/installed-cli-launch.ts"), "utf8");

test("launchd patch helpers use the unified namespace and self-remove", () => {
  assert.doesNotMatch(mainSource, /com\.tweaker/);
  assert.match(mainSource, /com\.therealityreport\.tweakers\.patch-helper\./);

  const helperBody = extractFunctionBody(mainSource, "startInstalledCliWithLaunchd");
  assert.match(helperBody, /submitInstalledCliWithLaunchd/);
  assert.match(launchSource, /trap cleanup_transient_launchd_job EXIT/);
  assert.match(launchSource, /launchctl remove/);
  assert.match(launchSource, /launchctl bootout/);
  assert.doesNotMatch(launchSource, /\|\|\s*true/);
});

test("launchctl submit is reserved for installer CLI helpers", () => {
  const helperStart = mainSource.indexOf("function startInstalledCliWithLaunchd");
  assert.notEqual(helperStart, -1, "missing launchd helper");
  const helperBody = extractFunctionBody(mainSource, "startInstalledCliWithLaunchd");
  const helperBodyStart = mainSource.indexOf("{", helperStart) + 1;
  const helperEnd = helperBodyStart + helperBody.length;
  // The tested helper owns construction of the exact launchctl arguments; the
  // runtime injects the process boundary here so launch failures are observable.
  const submitIndexes = [...mainSource.matchAll(/spawnSync\(command, \[\.\.\.submitArgs\], options\)/g)]
    .map((match) => match.index ?? -1);

  assert.equal(submitIndexes.length, 1, "unexpected launchctl invocation outside the installer helper");
  assert.ok(submitIndexes[0] >= helperStart && submitIndexes[0] < helperEnd, "launchctl submit must stay in the installer helper");
  assert.match(launchSource, /\["submit", "-l", input\.label, "--", "\/bin\/sh", "-c", shellCommand\]/);

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

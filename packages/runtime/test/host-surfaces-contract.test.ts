import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "packages/runtime/src/preload/host-surfaces.ts"), "utf8");
const host = readFileSync(resolve(process.cwd(), "packages/runtime/src/preload/tweak-host.ts"), "utf8");
const sdk = readFileSync(resolve(process.cwd(), "packages/sdk/src/index.ts"), "utf8");

test("host surfaces expose the approved semantic renderer seam", () => {
  for (const kind of ["projects", "assistant-turns", "composer", "thread-context", "usage", "command-menu", "account-menu", "settings-rows", "titlebar-controls"]) {
    assert.match(source, new RegExp(`"${kind}"`));
  }
  assert.match(sdk, /host: HostUiApi/);
  assert.match(host, /host: hostUiApi/);
});

test("all Tweakers share one coalesced mutation observer", () => {
  assert.match(source, /let sharedObserver: MutationObserver \| null = null/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /sharedObserver = new MutationObserver/);
  assert.match(source, /observe\(document\.documentElement, \{[\s\S]*attributeFilter:[\s\S]*characterData: true,[\s\S]*subtree: true/);
  assert.match(source, /function safelyNotify/);
});

test("surface diagnostics and active project context are bounded", () => {
  assert.match(source, /MAX_MATCHES = 100/);
  assert.match(source, /getActiveProject/);
  assert.match(source, /confidence/);
  assert.match(source, /const matches = queryHostSurfaces\(kind\)\.slice\(0, MAX_MATCHES\)/);
});

test("project surfaces fail closed instead of inheriting route context", () => {
  const projectRows = source.slice(source.indexOf("function projectRows"), source.indexOf("function threadContexts"));
  assert.match(projectRows, /directProjectIdentity/);
  assert.match(projectRows, /data-app-action-sidebar-project-id/);
  assert.match(projectRows, /fiberForNode\(element\)[^\n]*memoizedProps/);
  assert.doesNotMatch(projectRows, /getBoundingClientRect/);
  assert.doesNotMatch(projectRows, /fiberProps\(element\)/);
  assert.doesNotMatch(projectRows, /compact\(element\.textContent\) === "Projects"/);
});

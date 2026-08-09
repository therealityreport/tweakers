import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "packages/runtime/src/main.ts"), "utf8");

test("main tweaks can open native Settings only through the permission-checked owned command", () => {
  const start = source.indexOf("function makeCodexApi");
  const end = source.indexOf("function makeWindowLikeForView", start);
  assert.ok(start >= 0 && end > start);
  const api = source.slice(start, end);
  const settings = api.slice(api.indexOf("settings:"), api.indexOf("windows:"));
  assert.match(settings, /assertTweakPermission\(tweak, "settings"\)/);
  assert.match(settings, /ownedCodexRenderer\(ownerWebContentsId\)/);
  assert.match(settings, /openNativeSettingsFromApplicationMenu/);
  assert.match(settings, /if \(!sender\) return false/);
});

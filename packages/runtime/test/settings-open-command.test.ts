import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "packages/runtime/src/main.ts"), "utf8");

test("Settings open requests use one visible application-menu command", () => {
  const helperStart = source.indexOf("function openNativeSettingsFromApplicationMenu");
  const helperEnd = source.indexOf("// 3. IPC", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /Menu\.getApplicationMenu\(\)/);
  assert.match(helper, /item\.enabled === false \|\| item\.visible === false/);
  assert.match(helper, /if \(unique\.length !== 1\) return false/);
  assert.doesNotMatch(helper, /globalShortcut|sendInputEvent/);
  assert.match(source, /ipcMain\.handle\("tweaker:open-settings"/);
});

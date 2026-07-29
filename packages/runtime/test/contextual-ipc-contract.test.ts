import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const main = readFileSync(resolve(process.cwd(), "packages/runtime/src/main.ts"), "utf8");
const preload = readFileSync(resolve(process.cwd(), "packages/runtime/src/preload/tweak-host.ts"), "utf8");
const sdk = readFileSync(resolve(process.cwd(), "packages/sdk/src/index.ts"), "utf8");

test("contextual IPC exposes bounded sender identity and cleanup-returning SDK contracts", () => {
  assert.match(sdk, /export interface TweakIpcInvokeContext \{[\s\S]*sender: Readonly<\{ webContentsId: number \}>/);
  assert.match(sdk, /handleWithContext\?\([\s\S]*\): \(\) => void/);
  assert.match(sdk, /sendToRenderer\?\(webContentsId: number, channel: string/);
  assert.doesNotMatch(sdk, /IpcMainInvokeEvent|Electron\.Event/);
});

test("main contextual handler binds only an owned live BrowserWindow renderer", () => {
  const owned = main.slice(main.indexOf("function ownedCodexRenderer"), main.indexOf("function makeMainFs"));
  assert.match(owned, /Number\.isSafeInteger\(webContentsId\)/);
  assert.match(owned, /webContents\.fromId\(webContentsId\)/);
  assert.match(owned, /target\.isDestroyed\(\)/);
  assert.match(owned, /BrowserWindow\.fromWebContents\(target\)/);
  assert.match(owned, /owner\.webContents !== target/);
  assert.match(owned, /BrowserWindow\.getAllWindows\(\)/);

  const bridge = main.slice(main.indexOf("function makeMainIpc"), main.indexOf("function makeMainFs"));
  assert.match(bridge, /sender: Object\.freeze\(\{ webContentsId: sender\.id \}\)/);
  assert.match(bridge, /return handler\(context, \.\.\.args\)/);
  assert.doesNotMatch(bridge, /handler\(event/);
});

test("handler disposal cannot remove a later replacement and exact delivery never guesses primary", () => {
  const bridge = main.slice(main.indexOf("function makeMainIpc"), main.indexOf("function makeMainFs"));
  assert.match(bridge, /const registration = Symbol\(channel\)/);
  assert.match(bridge, /mainIpcHandlerRegistrations\.get\(channel\) !== registration/);
  const exactDelivery = bridge.slice(bridge.indexOf("sendToRenderer:"), bridge.indexOf("invoke:"));
  assert.match(exactDelivery, /ownedCodexRenderer\(webContentsId\)/);
  assert.doesNotMatch(exactDelivery, /getPrimaryCodexWindow/);
});

test("renderer and main IPC operations freeze the declared ipc permission requirement", () => {
  assert.match(preload, /must declare ipc permission/);
  assert.match(preload, /on: \(c, h\) => \{\s*assertIpcPermission\(\)/);
  assert.match(preload, /send: \(c, \.\.\.args\) => \{\s*assertIpcPermission\(\)/);
  assert.match(preload, /invoke: <T>\(c: string, \.\.\.args: unknown\[\]\) => \{\s*assertIpcPermission\(\)/);
  assert.match(main, /const requireIpc = \(\) => assertTweakPermission\(tweak, "ipc"\)/);
});

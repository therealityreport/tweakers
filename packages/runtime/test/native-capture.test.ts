import test from "node:test";
import assert from "node:assert/strict";
import { createNativeCaptureBridge } from "../src/preload/native-capture";
import { nativeServicesDescriptor } from "../src/native-services-descriptor";

test("native services fail visibly before registration and delegate without changing settings", async () => {
  const bridge = createNativeCaptureBridge();
  await assert.rejects(bridge.api.appshots.getState(), /unavailable/);
  const calls: unknown[] = [];
  const state = { supported: true, hotkey: "DoubleCommand" };
  assert.equal(bridge.transport.register({ appshots: {
    async getState() { calls.push("state"); return state; },
    async setHotkey(value) { calls.push(value); return { hotkey: value }; },
  }, computerHistory: { async getState() { calls.push("history"); return { state: "running" }; } } }), true);
  assert.deepEqual(await bridge.api.appshots.getState(), state);
  assert.deepEqual(calls, ["state"]);
  await bridge.api.appshots.setHotkey(null);
  assert.deepEqual(calls, ["state", null]);
});

test("native facade discovery rejects ambiguous and unrelated await-services exports", () => {
  const source = "import{native as wrong}from'other';async function init(){native=await remote.services,native.threadReadState.initialize(target)}export{native as facade,other as extra}";
  assert.deepEqual(nativeServicesDescriptor(new Map([["app-shared-abc123.js", source]])), { asset: "app-shared-abc123.js", exportName: "facade" });
  assert.equal(nativeServicesDescriptor(new Map([["app-shared-abc123.js", source], ["app-initial-def456.js", source]])), null);
  assert.equal(nativeServicesDescriptor(new Map([["app-shared-abc123.js", source.replace(".threadReadState", ".unknown")]])), null);
});

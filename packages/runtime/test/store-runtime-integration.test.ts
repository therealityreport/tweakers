import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { createTweakLifecycleBarrier } from "../src/tweak-lifecycle-barrier";
const main = readFileSync("packages/runtime/src/main.ts", "utf8");
function compile(source: string) { return transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText; }
function mainPort() {
  const ipc = new EventEmitter();
  const body = main.slice(main.indexOf("async function storeRendererLifecycle"), main.indexOf("async function installStoreTweak"));
  const run = new Function("createTweakLifecycleBarrier", "randomUUID", "ipcMain", "rendererLifecycleEpoch", compile(body + "\nreturn storeRendererLifecycle;"))(createTweakLifecycleBarrier, randomUUID, ipc, (sender: any) => sender.epoch);
  const frame = {}, sender = Object.assign(new EventEmitter(), { id: 2, mainFrame: frame, epoch: 1, isDestroyed: () => false, send: (_channel: string, _payload: unknown) => {} });
  const session = { token: "host-generation-1", sender, frame, epoch: 1 };
  return { ipc, run, sender, session, frame };
}
test("main store integration binds each shutdown round to a fresh nonce and exact frame", async () => {
  const f = mainPort(); let prior: any; let rounds = 0;
  f.sender.send = (_channel, request: any) => {
    rounds++;
    if (prior) assert.notEqual(request.instanceToken, prior.instanceToken);
    const wrongFrame = { sender: f.sender, senderFrame: {} };
    f.ipc.emit("tweaker:store-lifecycle-ack", wrongFrame, { ...request, ok: false });
    if (prior) f.ipc.emit("tweaker:store-lifecycle-ack", { sender: f.sender, senderFrame: f.frame }, { ...prior, ok: false });
    f.ipc.emit("tweaker:store-lifecycle-ack", { sender: f.sender, senderFrame: f.frame }, { ...request, ok: true });
    prior = request;
  };
  await f.run("operation-1", "shutdown", "co.example.tweak", [f.session]);
  await f.run("operation-1", "shutdown", "co.example.tweak", [f.session]);
  assert.equal(rounds, 2); assert.equal(f.ipc.listenerCount("tweaker:store-lifecycle-ack"), 0);
});
test("main store integration rejects a required document navigating during shutdown", async () => {
  const f = mainPort();
  f.sender.send = () => { f.sender.epoch++; f.sender.emit("did-start-navigation", {}, "next", false, true); };
  await assert.rejects(f.run("operation-2", "shutdown", "co.example.tweak", [f.session]), /changed/);
  assert.equal(f.sender.listenerCount("did-start-navigation"), 0);
});
function preloadPort(fail: "stop" | "start" | null, booting = false) {
  const source = readFileSync("packages/runtime/src/preload/index.ts", "utf8"), ipc = new EventEmitter();
  const acks: any[] = [], actions: string[] = [];
  Object.assign(ipc, { send: (_name: string, value: any) => acks.push(value) });
  const body = source.slice(source.indexOf("function subscribeReload()"), source.indexOf("function requestTweakReload()"));
  new Function("ipcRenderer", "requestTweakReload", "teardownTweakHost", "startTweakHost", "mountManager", compile(`let bootingTweaks=${booting}, storeLifecycleOperation=null, storeLifecycleHeld=false, reloading=null;\n${body}\nsubscribeReload();`))(
    ipc, () => {}, async () => { actions.push("stop"); if (fail === "stop") throw new Error("cleanup failed"); },
    async () => { actions.push("start"); if (fail === "start") throw new Error("activation failed"); }, async () => { actions.push("mount"); },
  );
  return { actions, acks, request: async (phase: string) => { ipc.emit("tweaker:store-lifecycle", {}, { operationId: "operation-1", instanceToken: "nonce", tweakId: "co.example.tweak", phase }); await new Promise(resolve => setImmediate(resolve)); } };
}
test("preload acknowledges actual shutdown and activation and refuses failed cleanup", async () => {
  const f = preloadPort(null); await f.request("shutdown"); await f.request("activate");
  assert.deepEqual(f.actions, ["stop", "start", "mount"]); assert.deepEqual(f.acks.map(ack => ack.ok), [true,true]);
  for (const phase of ["shutdown", "activate"]) {
    const bad = preloadPort(phase === "shutdown" ? "stop" : "start"); await bad.request(phase);
    assert.equal(bad.acks[0].ok, false);
  }
  const boot = preloadPort(null, true); await boot.request("shutdown"); assert.equal(boot.acks[0].ok, false); assert.deepEqual(boot.actions, []);
});

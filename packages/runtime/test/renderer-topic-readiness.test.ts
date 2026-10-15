import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { consolidateTweakTopics, topicMigrationOwner } from "../src/tweak-topic-migration";
const source = readFileSync("packages/runtime/src/main.ts", "utf8");
function fixture() {
  const frame = {};
  let epoch = 1;
  const handlers = new Map<string, Function>();
  const sender = { id: 1, mainFrame: frame, isDestroyed: () => false, on: (name: string, fn: Function) => handlers.set(name, fn), once: () => {} };
  const window = { webContents: sender, isDestroyed: () => false };
  const legacy = "co.tweakers.thread-summary-profiles", owner = "co.tweakers.projects";
  const tweaks = [{ manifest: { id: legacy, version: "0.1.0", scope: "renderer" }, enabled: true }, { manifest: { id: owner, version: "0.8.0", scope: "renderer" }, enabled: true }];
  const body = source.slice(source.indexOf("interface RendererLifecycleSession"), source.indexOf("function runtimeReadyInitializedTweakIds"));
  const compiled = transpileModule(body + "\nreturn {rendererTweakReady, rendererLifecycleSessions};", { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const api = new Function("exactIndependentTweakersPrimaryWindow", "accountsBrokerNavigationTracker", "tweakState", "isTweakEnabled", "topicMigrationOwner", compiled)(() => window, () => ({ epoch }), { discovered: tweaks }, (id: string) => tweaks.find(t => t.manifest.id === id)?.enabled, topicMigrationOwner);
  api.rendererTweakReady(legacy);
  const session = { token: "attempt:frame:1", sender, frame, epoch: 0, ready: new Set<string>(), delegations: new Map<string, string>() };
  api.rendererLifecycleSessions.set(sender.id, session);
  return { api, session, sender, tweaks, legacy, owner, navigate: () => handlers.get("did-start-navigation")?.({}, "next", false, true) };
}
test("persisted topic migration unlocks Settings only after current owner readiness", () => {
  const f = fixture(), values = new Map<string, string>();
  const suppressed = consolidateTweakTopics(f.tweaks, { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key,value) => { values.set(key,value); }, removeItem: key => { values.delete(key); } });
  assert.equal(suppressed.has(f.legacy), true);
  assert.equal(f.api.rendererTweakReady(f.legacy), false);
  f.session.delegations.set(f.legacy, topicMigrationOwner(f.legacy, f.tweaks)!);
  assert.equal(f.api.rendererTweakReady(f.legacy), false);
  f.session.ready.add(f.owner);
  assert.equal(f.api.rendererTweakReady(f.legacy), true);
  f.tweaks[1]!.enabled = false;
  assert.equal(f.api.rendererTweakReady(f.legacy), false);
});
test("stale frame and failed owner cannot prove delegated renderer readiness", () => {
  const f = fixture();
  f.session.delegations.set(f.legacy, f.owner); f.session.ready.add(f.owner);
  assert.equal(f.api.rendererTweakReady(f.legacy), true);
  f.session.ready.delete(f.owner); assert.equal(f.api.rendererTweakReady(f.legacy), false);
  f.session.ready.add(f.owner); f.navigate(); assert.equal(f.api.rendererTweakReady(f.legacy), false);
});
test("failed migration and unsupported owner versions cannot delegate", () => {
  const f = fixture();
  assert.equal(consolidateTweakTopics(f.tweaks, { length: 0, key: () => null, getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} }).size, 0);
  f.tweaks[1]!.manifest.version = "0.7.9";
  assert.equal(topicMigrationOwner(f.legacy, f.tweaks), null);
});

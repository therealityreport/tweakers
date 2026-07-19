import assert from "node:assert/strict";
import test from "node:test";
import {
  isMainProcessTweakScope,
  loadTweaksInitially,
  reloadTweaks,
  setTweakEnabledAndReload,
  type SetTweakEnabledAndReloadDeps,
} from "../src/tweak-lifecycle";

test("isMainProcessTweakScope includes main, both, and omitted scopes", () => {
  assert.equal(isMainProcessTweakScope("main"), true);
  assert.equal(isMainProcessTweakScope("both"), true);
  assert.equal(isMainProcessTweakScope(undefined), true);
});

test("isMainProcessTweakScope excludes renderer-only tweaks", () => {
  assert.equal(isMainProcessTweakScope("renderer"), false);
});

test("reloadTweaks stops, clears, loads, then broadcasts", async () => {
  const calls: string[] = [];

  await reloadTweaks("manual", deps(calls));

  assert.deepEqual(calls, [
    "log:reloading tweaks (manual)",
    "stopAllMainTweaks",
    "clearTweakModuleCache",
    "loadAllMainTweaks",
    "broadcastReload",
  ]);
});

test("setTweakEnabledAndReload enables a tweak and performs a full reload", async () => {
  const calls: string[] = [];

  const result = await setTweakEnabledAndReload("com.example.both", true, deps(calls));

  assert.equal(result, true);
  assert.deepEqual(calls, [
    "setTweakEnabled:com.example.both:true",
    "log:tweak com.example.both enabled=true",
    "log:reloading tweaks (enabled-toggle)",
    "stopAllMainTweaks",
    "clearTweakModuleCache",
    "loadAllMainTweaks",
    "broadcastReload",
  ]);
});

test("setTweakEnabledAndReload disables a tweak and performs a full reload", async () => {
  const calls: string[] = [];

  await setTweakEnabledAndReload("com.example.both", false, deps(calls));

  assert.deepEqual(calls, [
    "setTweakEnabled:com.example.both:false",
    "log:tweak com.example.both enabled=false",
    "log:reloading tweaks (enabled-toggle)",
    "stopAllMainTweaks",
    "clearTweakModuleCache",
    "loadAllMainTweaks",
    "broadcastReload",
  ]);
});

test("setTweakEnabledAndReload coerces truthy and falsy enabled values", async () => {
  const truthyCalls: string[] = [];
  const falsyCalls: string[] = [];

  await setTweakEnabledAndReload("com.example.truthy", 1, deps(truthyCalls));
  await setTweakEnabledAndReload("com.example.falsy", "", deps(falsyCalls));

  assert.equal(truthyCalls[0], "setTweakEnabled:com.example.truthy:true");
  assert.equal(falsyCalls[0], "setTweakEnabled:com.example.falsy:false");
});

test("setTweakEnabledAndReload does not reload if persisting the flag fails", async () => {
  const calls: string[] = [];

  await assert.rejects(
    async () =>
      setTweakEnabledAndReload("com.example.fail", true, {
        ...deps(calls),
        setTweakEnabled() {
          calls.push("setTweakEnabled");
          throw new Error("write failed");
        },
      }),
    /write failed/,
  );

  assert.deepEqual(calls, ["setTweakEnabled"]);
});

test("reloadTweaks stops before clearing cache when stop fails", async () => {
  const calls: string[] = [];

  await assert.rejects(
    async () =>
      reloadTweaks("manual", {
        ...deps(calls),
        stopAllMainTweaks() {
          calls.push("stopAllMainTweaks");
          throw new Error("stop failed");
        },
      }),
    /stop failed/,
  );

  assert.deepEqual(calls, ["log:reloading tweaks (manual)", "stopAllMainTweaks"]);
});

test("reloadTweaks awaits loading before broadcasting and serializes overlapping reloads", async () => {
  const calls: string[] = [];
  let releaseFirstLoad!: () => void;
  const firstLoad = new Promise<void>((resolve) => { releaseFirstLoad = resolve; });
  let loadCount = 0;
  const reloadDeps = {
    ...deps(calls),
    async loadAllMainTweaks() {
      loadCount += 1;
      calls.push(`load:start:${loadCount}`);
      if (loadCount === 1) await firstLoad;
      calls.push(`load:end:${loadCount}`);
    },
  };

  const first = reloadTweaks("first", reloadDeps);
  const second = reloadTweaks("second", reloadDeps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    "log:reloading tweaks (first)",
    "stopAllMainTweaks",
    "clearTweakModuleCache",
    "load:start:1",
  ]);

  releaseFirstLoad();
  await Promise.all([first, second]);
  assert.deepEqual(calls.slice(-6), [
    "log:reloading tweaks (second)",
    "stopAllMainTweaks",
    "clearTweakModuleCache",
    "load:start:2",
    "load:end:2",
    "broadcastReload",
  ]);
  assert.equal(calls.at(-1), "broadcastReload");
});

test("reloadTweaks waits for an in-flight initial load on the same queue", async () => {
  const calls: string[] = [];
  let releaseInitial!: () => void;
  const initialBarrier = new Promise<void>((resolve) => { releaseInitial = resolve; });
  const initial = loadTweaksInitially({
    async loadAllMainTweaks() {
      calls.push("initial:start");
      await initialBarrier;
      calls.push("initial:end");
    },
  });
  const reload = reloadTweaks("after-startup", deps(calls));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["initial:start"]);
  releaseInitial();
  await Promise.all([initial, reload]);
  assert.deepEqual(calls, [
    "initial:start",
    "initial:end",
    "log:reloading tweaks (after-startup)",
    "stopAllMainTweaks",
    "clearTweakModuleCache",
    "loadAllMainTweaks",
    "broadcastReload",
  ]);
});

function deps(calls: string[]): SetTweakEnabledAndReloadDeps {
  return {
    logInfo(message) {
      calls.push(`log:${message}`);
    },
    setTweakEnabled(id, enabled) {
      calls.push(`setTweakEnabled:${id}:${enabled}`);
    },
    stopAllMainTweaks() {
      calls.push("stopAllMainTweaks");
    },
    clearTweakModuleCache() {
      calls.push("clearTweakModuleCache");
    },
    loadAllMainTweaks() {
      calls.push("loadAllMainTweaks");
    },
    broadcastReload() {
      calls.push("broadcastReload");
    },
  };
}

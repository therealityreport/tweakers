import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ACCEPTANCE_CONFIG_ENV, ACCEPTANCE_TWEAK_IDS, resolveAcceptanceConfig, runRuntimeDiagnosticDiskOperation } from "../src/acceptance-config";
import { publishIndependentTweakersRuntimeReadyReceipt } from "../src/desktop-update-startup";
import { getAndPublishWatcherHealth, getAndPublishWatcherHealthAsync } from "../src/watcher-health";
import { setTweakEnabledAndReload } from "../src/tweak-lifecycle";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-acceptance-config-")));
  const directory = join(root, "acceptance", "12345678-1234-1234-1234-123456789abc");
  mkdirSync(join(root, "acceptance"), { mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const canonical = join(root, "config.json");
  const path = join(directory, "config.json");
  const baseline = {
    schemaVersion: 1,
    tweaker: { autoUpdate: false, codexCliLane: "bundled" },
    tweaks: Object.fromEntries(ACCEPTANCE_TWEAK_IDS.map(id => [id, { enabled: false, preserved: "setting" }])),
    nativeApproval: { policy: "unchanged" },
    account: { binding: "unchanged" },
  };
  const original = JSON.stringify(baseline);
  writeFileSync(canonical, original, { mode: 0o600 });
  writeFileSync(path, original, { mode: 0o600 });
  const input = { userRoot: root, derivedVariant: true, healthCheckOnly: false, environment: { [ACCEPTANCE_CONFIG_ENV]: path } };
  return { root, directory, canonical, path, baseline, original, input, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("normal configuration has no override and no acceptance file accesses", () => {
  assert.equal(resolveAcceptanceConfig({ userRoot: "/missing", derivedVariant: false, healthCheckOnly: false, environment: {} }), null);
});

test("only three enabled booleans can change and be restored; canonical bytes remain exact", () => {
  const f = fixture();
  const config = resolveAcceptanceConfig(f.input)!;
  try {
    assert.equal(config.directory, f.directory);
    const enabled = config.read();
    const tweaks = enabled.tweaks as Record<string, { enabled: boolean }>;
    for (const id of ACCEPTANCE_TWEAK_IDS) tweaks[id].enabled = true;
    config.write(enabled);
    assert.equal((config.read().tweaks as typeof tweaks)[ACCEPTANCE_TWEAK_IDS[0]].enabled, true);
    config.write(f.baseline);
    assert.deepEqual(config.read(), f.baseline);
    assert.equal(readFileSync(f.canonical, "utf8"), f.original);
  } finally { config.close(); f.close(); }
});

test("native, health, empty, outside and non-UUID overrides fail closed", () => {
  const f = fixture();
  try {
    for (const input of [
      { ...f.input, derivedVariant: false }, { ...f.input, healthCheckOnly: true },
      ...["", f.canonical, join(f.root, "other", "config.json"), join(f.root, "acceptance", "not-a-uuid", "config.json")]
        .map(path => ({ ...f.input, environment: { [ACCEPTANCE_CONFIG_ENV]: path } })),
    ]) assert.throws(() => resolveAcceptanceConfig(input));
  } finally { f.close(); }
});

test("unknown settings, approval/account changes and non-boolean enablement cannot be written", () => {
  const f = fixture();
  const config = resolveAcceptanceConfig(f.input)!;
  try {
    for (const value of [
      { ...f.baseline, extra: true }, { ...f.baseline, schemaVersion: 2 },
      { ...f.baseline, nativeApproval: { policy: "changed" } },
      { ...f.baseline, account: { binding: "changed" } },
      { ...f.baseline, tweaks: { ...f.baseline.tweaks, other: { enabled: true } } },
      { ...f.baseline, tweaks: { ...f.baseline.tweaks, [ACCEPTANCE_TWEAK_IDS[0]]: { enabled: 1, preserved: "setting" } } },
    ]) assert.throws(() => config.write(value));
    assert.equal(readFileSync(f.path, "utf8"), f.original);
    assert.equal(readFileSync(f.canonical, "utf8"), f.original);
    assert.equal(config.rejectedWrites, 6);
    assert.deepEqual(config.read(), f.baseline, "rejected background proposals leave the approved copy usable");
  } finally { config.close(); f.close(); }
});

test("unmigrated legacy baseline refuses startup without changing either file", () => {
  const f = fixture();
  try {
    const value = JSON.stringify({ ...f.baseline, codexPlusPlus: { codexCliLane: "beta" } });
    writeFileSync(f.canonical, value);
    writeFileSync(f.path, value);
    assert.throws(() => resolveAcceptanceConfig(f.input));
    assert.equal(readFileSync(f.canonical, "utf8"), value);
    assert.equal(readFileSync(f.path, "utf8"), value);
  } finally { f.close(); }
});

test("actual enabled-toggle lifecycle rejects forbidden writes before reload and acknowledges permitted toggles", async () => {
  const f = fixture();
  const config = resolveAcceptanceConfig(f.input)!;
  const calls: string[] = [];
  const deps = {
    logInfo() {},
    setTweakEnabled(id: string, enabled: boolean) {
      const state = config.read();
      const tweaks = state.tweaks as Record<string, Record<string, unknown>>;
      tweaks[id] = { ...tweaks[id], enabled };
      config.write(state);
    },
    stopAllMainTweaks() { calls.push("stop"); },
    clearTweakModuleCache() { calls.push("clear"); },
    loadAllMainTweaks() { calls.push("load"); },
    broadcastReload() { calls.push("broadcast"); },
  };
  try {
    await assert.rejects(setTweakEnabledAndReload("co.tweakers.projects", false, deps));
    assert.deepEqual(calls, [], "rejected IPC writer cannot acknowledge or reload");
    assert.equal(await setTweakEnabledAndReload(ACCEPTANCE_TWEAK_IDS[0], true, deps), true);
    assert.deepEqual(calls, ["stop", "clear", "load", "broadcast"]);
    assert.equal(readFileSync(f.canonical, "utf8"), f.original);
  } finally { config.close(); f.close(); }
});

test("existing extra changes or a canonical owner already enabled refuse initial acceptance", () => {
  const f = fixture();
  try {
    writeFileSync(f.path, JSON.stringify({ ...f.baseline, extra: true }));
    assert.throws(() => resolveAcceptanceConfig(f.input));
    writeFileSync(f.path, f.original);
    const next = structuredClone(f.baseline);
    next.tweaks[ACCEPTANCE_TWEAK_IDS[0]].enabled = true;
    writeFileSync(f.canonical, JSON.stringify(next));
    assert.throws(() => resolveAcceptanceConfig(f.input));
  } finally { f.close(); }
});

test("canonical changes and replacement invalidate every subsequent read and write", () => {
  for (const replace of [false, true]) {
    const f = fixture();
    const config = resolveAcceptanceConfig(f.input)!;
    try {
      if (replace) {
        writeFileSync(join(f.root, "replacement"), f.original, { mode: 0o600 });
        renameSync(join(f.root, "replacement"), f.canonical);
      } else writeFileSync(f.canonical, JSON.stringify({ ...f.baseline, extra: true }));
      assert.throws(() => config.read());
      assert.throws(() => config.write(f.baseline));
      if (!replace) {
        writeFileSync(f.canonical, f.original);
        assert.throws(() => config.read(), "detected canonical drift permanently invalidates this launch");
      }
      assert.equal(readFileSync(f.path, "utf8"), f.original);
    } finally { config.close(); f.close(); }
  }
});

test("private mode, regular unlinked file and pinned identity are enforced", () => {
  for (const change of ["file-mode", "parent-mode", "symlink", "hardlink", "replacement", "malformed"] as const) {
    const f = fixture();
    const config = resolveAcceptanceConfig(f.input)!;
    try {
      if (change === "file-mode") chmodSync(f.path, 0o644);
      if (change === "parent-mode") chmodSync(f.directory, 0o755);
      if (change === "symlink") { renameSync(f.path, `${f.path}.old`); symlinkSync(f.canonical, f.path); }
      if (change === "hardlink") linkSync(f.path, `${f.path}.link`);
      if (change === "replacement") { copyFileSync(f.path, `${f.path}.next`); renameSync(`${f.path}.next`, f.path); }
      if (change === "malformed") writeFileSync(f.path, "{");
      assert.throws(() => config.read(), change);
      assert.throws(() => config.write(f.baseline), change);
      assert.equal(readFileSync(f.canonical, "utf8"), f.original);
    } finally { config.close(); f.close(); }
  }
});

test("replaced parent directories never redirect settings writes into canonical data", () => {
  const f = fixture();
  const config = resolveAcceptanceConfig(f.input)!;
  try {
    renameSync(f.directory, `${f.directory}.old`);
    symlinkSync(f.root, f.directory);
    assert.throws(() => config.write(f.baseline));
    assert.equal(readFileSync(f.canonical, "utf8"), f.original);
  } finally { config.close(); f.close(); }
});

test("acceptance diagnostics use effective settings and publish no canonical health snapshot", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "state.json"), JSON.stringify({ version: "acceptance", watcher: "none" }));
    const probes = { platformKind: "linux" as const, pathExists: () => false };
    const publisher = { writeAtomic() { assert.fail("acceptance must not publish production health"); } };
    const read = () => ({ ...f.baseline, tweaker: { autoUpdate: true } });
    const health = getAndPublishWatcherHealth(f.root, probes, publisher, read);
    assert.equal(health.checks.find(check => check.name === "Automatic refresh")?.detail, "enabled");
    await getAndPublishWatcherHealthAsync(f.root, probes, publisher, read);
    assert.equal(existsSync(join(f.root, "watcher-health.json")), false);
    assert.throws(() => getAndPublishWatcherHealth(f.root, probes, publisher, () => { throw new Error("invalid override"); }), /invalid override/);
  } finally { f.close(); }
});

test("acceptance diagnostic disk operations ignore linked children and preserve canonical settings and proofs", () => {
  const f = fixture();
  const config = resolveAcceptanceConfig(f.input)!;
  const proofNames = ["environment-runtime-proof.json", "runtime-ready.json", "independent-live-health.json", "tweak-lifecycle.json"];
  try {
    for (const name of proofNames) {
      writeFileSync(join(f.root, name), `canonical-${name}`);
      symlinkSync(name === "tweak-lifecycle.json" ? f.canonical : join(f.root, name), join(f.directory, name));
    }
    assert.deepEqual(config.read(), f.baseline, "linked diagnostic children do not make the settings copy invalid");
    const lifecycle = join(f.directory, "tweak-lifecycle.json");
    runRuntimeDiagnosticDiskOperation(config, () => writeFileSync(lifecycle, '{"records":{}}'));
    const loaded = runRuntimeDiagnosticDiskOperation(config, () => readFileSync(lifecycle, "utf8"));
    assert.equal(loaded, undefined, "acceptance lifecycle must initialize in memory");
    runRuntimeDiagnosticDiskOperation(config, () => rmSync(join(f.directory, "runtime-ready.json"), { force: true }));
    for (const name of ["independent-live-health.json", "runtime-ready.json"]) {
      runRuntimeDiagnosticDiskOperation(config, () => publishIndependentTweakersRuntimeReadyReceipt(join(f.directory, name), { acceptance: true }));
    }
    runRuntimeDiagnosticDiskOperation(config, () => {
      writeFileSync(join(f.directory, "environment-runtime-proof.json.tmp"), "acceptance");
      renameSync(join(f.directory, "environment-runtime-proof.json.tmp"), join(f.directory, "environment-runtime-proof.json"));
    });
    assert.equal(readFileSync(f.canonical, "utf8"), f.original);
    for (const name of proofNames) {
      assert.equal(readFileSync(join(f.root, name), "utf8"), `canonical-${name}`);
      assert.equal(lstatSync(join(f.directory, name)).isSymbolicLink(), true, "no diagnostic leaf was read, removed, or replaced");
    }
    assert.equal(existsSync(join(f.directory, "environment-runtime-proof.json.tmp")), false);
  } finally { config.close(); f.close(); }
});

test("acceptance diagnostic removal and publication cannot follow a replaced parent into canonical proofs", () => {
  const f = fixture();
  const config = resolveAcceptanceConfig(f.input)!;
  const proofNames = ["environment-runtime-proof.json", "runtime-ready.json", "independent-live-health.json", "tweak-lifecycle.json"];
  try {
    for (const name of proofNames) writeFileSync(join(f.root, name), `canonical-${name}`);
    renameSync(f.directory, `${f.directory}.old`);
    symlinkSync(f.root, f.directory);
    for (const operation of [
      () => rmSync(join(f.directory, "runtime-ready.json"), { force: true }),
      () => publishIndependentTweakersRuntimeReadyReceipt(join(f.directory, "independent-live-health.json"), { acceptance: true }),
      () => writeFileSync(join(f.directory, "tweak-lifecycle.json"), '{"records":{}}'),
      () => {
        writeFileSync(join(f.directory, "environment-runtime-proof.json.tmp"), "acceptance");
        renameSync(join(f.directory, "environment-runtime-proof.json.tmp"), join(f.directory, "environment-runtime-proof.json"));
      },
    ]) assert.throws(() => runRuntimeDiagnosticDiskOperation(config, operation));
    assert.equal(readFileSync(f.canonical, "utf8"), f.original);
    for (const name of proofNames) assert.equal(readFileSync(join(f.root, name), "utf8"), `canonical-${name}`);
    assert.equal(existsSync(join(f.root, "environment-runtime-proof.json.tmp")), false);
  } finally { config.close(); f.close(); }
});

test("normal runtime diagnostic disk operations still publish, read and remove their files", () => {
  const f = fixture();
  try {
    const path = join(f.root, "runtime-ready.json");
    runRuntimeDiagnosticDiskOperation(null, () => publishIndependentTweakersRuntimeReadyReceipt(path, { ordinary: true }));
    assert.deepEqual(JSON.parse(runRuntimeDiagnosticDiskOperation(null, () => readFileSync(path, "utf8"))!), { ordinary: true });
    runRuntimeDiagnosticDiskOperation(null, () => rmSync(path));
    assert.equal(existsSync(path), false);
  } finally { f.close(); }
});

test("main keeps bootstrap canonical and gates diagnostic disk operations while acceptance remains in memory", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.ok(source.indexOf("assertTweakersVariantBootstrap(") < source.indexOf("const acceptanceConfig = resolveAcceptanceConfig("));
  for (const file of ["environment-runtime-proof.json", "runtime-ready.json", "independent-live-health.json", "tweak-lifecycle.json"]) {
    assert.ok(source.includes(`join(userRoot, "${file}")`), file);
  }
  for (const name of ["readTweakLifecycleJournal", "writeTweakLifecycleJournal", "writeEnvironmentRuntimeProof", "publishIndependentTweakersLiveHealth"]) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\nfunction ", start + 1);
    assert.ok(start >= 0 && source.slice(start, end).includes("runRuntimeDiagnosticDiskOperation(acceptanceConfig,"), name);
  }
  assert.match(source, /runRuntimeDiagnosticDiskOperation\(acceptanceConfig, \(\) => \{\s*try \{ rmSync\(RUNTIME_READY_FILE/);
  assert.ok(source.includes("runRuntimeDiagnosticDiskOperation(acceptanceConfig, () => publishIndependentTweakersRuntimeReadyReceipt(RUNTIME_READY_FILE, receipt))"));
  assert.match(source, /function readRuntimeReadyExpectation\(\)[\s\S]*?if \(acceptanceConfig\) \{ acceptanceConfig\.read\(\); return null; \}/);
  assert.match(source, /function readState\(\)[\s\S]*?acceptanceConfig \? acceptanceConfig\.read\(\)/);
  assert.match(source, /function readState\(\)[\s\S]*?if \(acceptanceConfig\) throw error/);
  assert.match(source, /function writeState\([\s\S]*?if \(acceptanceConfig\) \{[\s\S]*?acceptanceConfig\.write\(/);
});

test("drift during a lifecycle journal write reports once through onDrift and still fails closed", () => {
  const f = fixture();
  const drifts: Error[] = [];
  const config = resolveAcceptanceConfig({ ...f.input, onDrift: (error) => { drifts.push(error); throw new Error("host stop failure must not mask drift"); } })!;
  try {
    assert.equal(config.drifted, false);
    let wrote = false;
    runRuntimeDiagnosticDiskOperation(config, () => { wrote = true; });
    assert.equal(wrote, false);
    assert.equal(drifts.length, 0);
    writeFileSync(f.canonical, JSON.stringify({ ...f.baseline, changed: true }), { mode: 0o600 });
    assert.throws(() => runRuntimeDiagnosticDiskOperation(config, () => { wrote = true; }), /acceptance must stop/);
    assert.equal(wrote, false, "no diagnostic write happens after drift");
    assert.equal(config.drifted, true);
    assert.equal(drifts.length, 1);
    assert.match(drifts[0]!.message, /acceptance must stop/);
    assert.throws(() => runRuntimeDiagnosticDiskOperation(config, () => { wrote = true; }), /acceptance must stop/);
    assert.throws(() => config.read(), /acceptance must stop/);
    assert.equal(drifts.length, 1, "onDrift fires exactly once");
    assert.equal(wrote, false);
  } finally { config.close(); f.close(); }
});

test("a closed acceptance override skips quit-time diagnostics instead of raising in the quit hook", () => {
  const f = fixture();
  const drifts: Error[] = [];
  const config = resolveAcceptanceConfig({ ...f.input, onDrift: (error) => { drifts.push(error); } })!;
  try {
    config.close();
    assert.equal(config.closed, true);
    let ran = false;
    assert.equal(runRuntimeDiagnosticDiskOperation(config, () => { ran = true; return 1; }), undefined);
    assert.equal(ran, false, "acceptance diagnostics never reach disk, even after close");
    assert.deepEqual(drifts, [], "closing is not drift");
    assert.equal(config.drifted, false);
    assert.throws(() => config.read(), /acceptance must stop/, "direct reads after close still fail closed");
  } finally { config.close(); f.close(); }
});

test("main stops a drifted acceptance launch deliberately through app.exit", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("const acceptanceConfig = resolveAcceptanceConfig(");
  const end = source.indexOf("\nconst CONFIG_FILE", start);
  const call = source.slice(start, end);
  assert.match(call, /onDrift: \(error\) => \{[\s\S]*?log\("error"[\s\S]*?app\.exit\(1\);/);
  assert.ok(source.indexOf("app.once(\"will-quit\", () => acceptanceConfig?.close())") > end);
});

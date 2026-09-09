import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
  nativeThreadInventoryFingerprint,
  type EndpointKey,
} from "../src/portable-continuity-projection.ts";
import {
  PortableDesktopLaunchError,
  authenticatedPortableDesktopPrelaunchWrapperPid,
  findPortableDesktopMainChunk,
  runPortableDesktopHandoff,
  runPortableDesktopManagerCommand,
  portableDesktopMainContractFingerprint,
  type PortableDesktopHandoffDependencies,
  type PortableDesktopLayoutV1,
} from "../src/portable-desktop-launch.ts";
import { prepareManagedAccountContinuityPrelaunch } from "../src/account-continuity-prelaunch.ts";

const NOW = "2026-09-05T19:30:00.000Z";
const INVENTORY_FINGERPRINT = nativeThreadInventoryFingerprint([]);

interface Fixture {
  root: string;
  layout: PortableDesktopLayoutV1;
  sourceGlobal: string;
  destinationGlobal: string;
  deps: PortableDesktopHandoffDependencies;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function privateJson(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function fixture(nested = false): Fixture {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweakers-portable-desktop-launch-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  const officialCodex = join(root, "official-codex");
  const officialTweakers = join(root, "official-tweakers");
  const variantTweakers = nested ? join(officialTweakers, "variants", "tweakers") : join(root, "variant-tweakers");
  const variantCodex = nested ? join(variantTweakers, "codex-home") : join(root, "variant-codex");
  const continuityRoot = join(root, "continuity-root");
  const inventoryRoot = join(root, "native-inventory");
  const officialApp = join(root, "ChatGPT.app");
  const variantApp = join(root, "Tweakers.app");
  const appData = join(root, "variant-app-data");
  for (const path of [
    home,
    officialCodex,
    officialTweakers,
    variantCodex,
    variantTweakers,
    continuityRoot,
    inventoryRoot,
    officialApp,
    variantApp,
    appData,
  ]) privateDirectory(path);

  const sourceGlobal = join(officialCodex, ".codex-global-state.json");
  const destinationGlobal = join(variantCodex, ".codex-global-state.json");
  privateJson(sourceGlobal, {
    "electron-persisted-atom-state": { appearanceTheme: "dark" },
    sourceOnly: "must-not-copy",
  });
  privateJson(destinationGlobal, {
    "electron-persisted-atom-state": {},
    destinationOnly: "preserved",
  });

  const layout: PortableDesktopLayoutV1 = {
    homeRoot: home,
    continuityRoot,
    nativeThreadInventoryStateRoot: inventoryRoot,
    official: {
      endpointKey: `sha256:${"a".repeat(64)}` as EndpointKey,
      appBundlePath: officialApp,
      codexHomeRoot: officialCodex,
      tweakersRoot: officialTweakers,
    },
    tweakers: {
      endpointKey: `sha256:${"b".repeat(64)}` as EndpointKey,
      appBundlePath: variantApp,
      codexHomeRoot: variantCodex,
      tweakersRoot: variantTweakers,
    },
    tweakersAppUserDataRoot: appData,
  };
  let transaction = 0;
  const deps: PortableDesktopHandoffDependencies = {
    layout: () => layout,
    randomId: () => `portable-desktop-${++transaction}-fixture`,
    readNativeThreadInventory: (input) => {
      assert.equal(input.stateRoot, inventoryRoot);
      return { state: "ready", fingerprint: INVENTORY_FINGERPRINT, threadIds: [] };
    },
    verifyBundleSchema: () => CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
    census: () => ({ observedAt: NOW, state: "zero", openFileCount: 0, unexpectedProcessCount: 0 }),
    wait: () => undefined,
    now: () => NOW,
  };
  return { root, layout, sourceGlobal, destinationGlobal, deps };
}

test("idle handoff publishes the merge before opening the requested desktop", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const events: string[] = [];

  const result = runPortableDesktopHandoff({
    target: "tweakers",
    launch: () => {
      const destination = readJson(f.destinationGlobal);
      const atoms = destination["electron-persisted-atom-state"] as Record<string, unknown>;
      assert.equal(atoms.appearanceTheme, "dark", "launch is ordered after the durable destination update");
      events.push("launch");
    },
  }, {
    ...f.deps,
    verifyBundleSchema: () => {
      events.push("schema");
      return CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1;
    },
  });

  assert.equal(result.status, "applied");
  assert.equal(result.launched, true);
  assert.equal(events.at(-1), "launch");
  const destination = readJson(f.destinationGlobal);
  assert.equal(destination.destinationOnly, "preserved");
  assert.equal(Object.hasOwn(destination, "sourceOnly"), false);
});

test("a live writer postpones the merge without changing state and still permits safe coexistence", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const before = readFileSync(f.destinationGlobal);
  let launches = 0;

  const result = runPortableDesktopHandoff({ target: "tweakers", launch: () => { launches += 1; } }, {
    ...f.deps,
    census: () => ({ observedAt: NOW, state: "running", openFileCount: 1, unexpectedProcessCount: 1 }),
  });

  assert.equal(result.status, "postponed");
  assert.equal(result.launched, true);
  assert.equal(launches, 1);
  assert.deepEqual(readFileSync(f.destinationGlobal), before);
  assert.equal(existsSync(join(f.layout.continuityRoot, "portable-continuity")), false);
});

test("a dual edit is returned as a conflict and neither applies nor launches", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.equal(runPortableDesktopHandoff({ target: "tweakers" }, f.deps).status, "applied");
  privateJson(f.sourceGlobal, { "electron-persisted-atom-state": { appearanceTheme: "light" } });
  privateJson(f.destinationGlobal, { "electron-persisted-atom-state": { appearanceTheme: "system" } });
  const before = readFileSync(f.destinationGlobal);
  const ledger = readFileSync(join(f.layout.continuityRoot, "portable-continuity", "continuity-state.v2.json"));
  let launched = false;

  const result = runPortableDesktopHandoff({ target: "tweakers", launch: () => { launched = true; } }, f.deps);

  assert.equal(result.status, "conflict");
  assert.equal(result.launched, false);
  assert.equal(launched, false);
  assert.ok(result.conflictFieldIds.includes("global-state.appearance-theme"));
  assert.deepEqual(readFileSync(f.destinationGlobal), before);
  assert.deepEqual(readFileSync(join(f.layout.continuityRoot, "portable-continuity", "continuity-state.v2.json")), ledger);
});

test("schema drift blocks explicit handoff but postpones authenticated startup without writes", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const before = readFileSync(f.destinationGlobal);
  let launched = false;

  const result = runPortableDesktopHandoff({ target: "tweakers", launch: () => { launched = true; } }, {
    ...f.deps,
    verifyBundleSchema: () => `sha256:${"c".repeat(64)}` as typeof CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
  });

  assert.equal(result.status, "unsupported-schema");
  assert.equal(result.launched, false);
  assert.equal(launched, false);
  assert.deepEqual(readFileSync(f.destinationGlobal), before);
  assert.equal(existsSync(join(f.layout.continuityRoot, "portable-continuity")), false);

  const sourceBefore = readFileSync(f.sourceGlobal);
  const manager = join(f.root, "Tweakers Manager Launcher");
  const wrapper = join(f.layout.tweakers.appBundlePath, "Contents", "MacOS", "ChatGPT");
  privateDirectory(dirname(wrapper));
  writeFileSync(wrapper, "wrapper", { mode: 0o500 });
  const startup = runPortableDesktopManagerCommand(["portable-desktop-prelaunch-v1"], {
    ...f.deps,
    verifyBundleSchema: () => `sha256:${"c".repeat(64)}` as typeof CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
    managerLauncher: () => manager,
    nodePid: () => 300,
    nodeParentPid: () => 200,
    processes: () => [
      { pid: 300, ppid: 200, command: "/private/node manager.mjs portable-desktop-prelaunch-v1" },
      { pid: 200, ppid: 100, command: `${manager} portable-desktop-prelaunch-v1` },
      { pid: 100, ppid: 1, command: wrapper },
    ],
    runCommand: (command) => {
      assert.equal(command, "/usr/bin/plutil");
      return { status: 0, stdout: "ChatGPT", stderr: "" };
    },
    prepareAccountContinuity: () => ({ state: "deferred", reason: "account-busy" }),
  });
  assert.equal(startup.exitCode, 0, "the authenticated wrapper may continue to Electron");
  assert.equal(startup.result.status, "postponed");
  assert.equal(startup.result.selectedFieldCount, 0);
  assert.equal(startup.result.destinationWriteFieldCount, 0);
  assert.equal(startup.result.intentFingerprint, null);
  assert.equal(startup.result.launched, false, "the manager leaves execve to the authenticated wrapper");
  assert.deepEqual(readFileSync(f.sourceGlobal), sourceBefore);
  assert.deepEqual(readFileSync(f.destinationGlobal), before);
  assert.equal(existsSync(join(f.layout.continuityRoot, "portable-continuity")), false);

});

test("the native inventory reader is loaded only through the verified sealed managed runtime", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const { readNativeThreadInventory: _unused, ...withoutReader } = f.deps;
  const sealedRoot = join(f.root, "sealed-managed-runtime");
  const required: string[] = [];
  let verified = 0;
  const result = runPortableDesktopHandoff({ target: "tweakers" }, {
    ...withoutReader,
    resolveManagedRuntime: () => ({ fingerprint: "d".repeat(64), root: sealedRoot }),
    verifyManagedRuntime: () => { verified += 1; },
    requireModule: (path) => {
      required.push(path);
      return {
        readCommittedNativeThreadInventoryV1: (input: { stateRoot: string }) => {
          assert.equal(input.stateRoot, f.layout.nativeThreadInventoryStateRoot);
          return { state: "ready", fingerprint: INVENTORY_FINGERPRINT, threadIds: [] };
        },
      };
    },
  });

  assert.equal(result.status, "applied");
  assert.equal(verified, 1);
  assert.deepEqual(required, [join(sealedRoot, "packages", "installer", "assets", "runtime", "account-router", "native-transfer.js")]);
});

test("a failed managed-runtime verification cannot load a reader or write state", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const { readNativeThreadInventory: _unused, ...withoutReader } = f.deps;
  const before = readFileSync(f.destinationGlobal);
  let required = 0;

  assert.throws(() => runPortableDesktopHandoff({ target: "tweakers" }, {
    ...withoutReader,
    resolveManagedRuntime: () => ({ fingerprint: "e".repeat(64), root: join(f.root, "tampered-runtime") }),
    verifyManagedRuntime: () => { throw new Error("tampered managed runtime"); },
    requireModule: () => { required += 1; return {}; },
  }), /tampered managed runtime/);

  assert.equal(required, 0);
  assert.deepEqual(readFileSync(f.destinationGlobal), before);
  assert.equal(existsSync(join(f.layout.continuityRoot, "portable-continuity")), false);
});

test("prelaunch admission requires the exact manager command and direct wrapper ancestry", () => {
  const manager = "/private/manager/Tweakers Manager Launcher";
  const wrapper = "/Applications/Tweakers.app/Contents/MacOS/ChatGPT";
  const valid = authenticatedPortableDesktopPrelaunchWrapperPid({
    nodePid: 300,
    nodeParentPid: 200,
    managerLauncher: manager,
    wrapperLauncher: wrapper,
    processes: [
      { pid: 300, ppid: 200, command: "/usr/local/bin/node /private/manager/manager.mjs portable-desktop-prelaunch-v1" },
      { pid: 200, ppid: 100, command: `${manager} portable-desktop-prelaunch-v1` },
      { pid: 100, ppid: 1, command: `${wrapper} --ordinary-switch` },
    ],
  });
  assert.equal(valid, 100);
  assert.equal(authenticatedPortableDesktopPrelaunchWrapperPid({
    nodePid: 300,
    nodeParentPid: 200,
    managerLauncher: manager,
    wrapperLauncher: wrapper,
    processes: [
      { pid: 300, ppid: 200, command: "node manager.mjs" },
      { pid: 200, ppid: 100, command: `${manager} arbitrary-command` },
      { pid: 100, ppid: 1, command: wrapper },
    ],
  }), null);
});

test("desktop schema lookup accepts one inspected main chunk and rejects ambiguity", () => {
  assert.equal(findPortableDesktopMainChunk({
    files: {
      "dist": { files: { "main-abc123.js": { size: 1 } } },
    },
  }), "dist/main-abc123.js");
  assert.throws(() => findPortableDesktopMainChunk({
    files: {
      "main-one.js": { size: 1 },
      "nested": { files: { "main-two.js": { size: 1 } } },
    },
  }), (error: unknown) => error instanceof PortableDesktopLaunchError && error.code === "desktop-main-chunk-ambiguous");
});


test("production-style nested installation containers keep distinct portable documents", () => {
  const f = fixture(true);
  try {
    const result = runPortableDesktopHandoff({ target: "tweakers" }, f.deps);
    assert.equal(result.status, "applied");
    assert.equal((readJson(f.destinationGlobal)["electron-persisted-atom-state"] as Record<string, unknown>).appearanceTheme, "dark");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("schema proof ignores generated names but detects executable contract changes", () => {
  const a = Buffer.from('const a=require("./src-12345678.js");loadSettings(a);\n//# sourceMappingURL=main-12345678.js.map');
  const b = Buffer.from('const a=require("./src-abcdefgh.js");loadSettings(a);\n//# sourceMappingURL=main-abcdefgh.js.map');
  assert.equal(portableDesktopMainContractFingerprint(a), portableDesktopMainContractFingerprint(b));
  assert.notEqual(portableDesktopMainContractFingerprint(a), portableDesktopMainContractFingerprint(Buffer.from(b.toString().replace('loadSettings(a)', 'discardSettings(a)'))));
});


test("authenticated prelaunch accepts launchd parent zero and postpones before recursive scans", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const manager = join(f.root, "Tweakers Manager Launcher");
  const wrapper = join(f.layout.tweakers.appBundlePath, "Contents", "MacOS", "ChatGPT");
  privateDirectory(dirname(wrapper));
  writeFileSync(wrapper, "wrapper", { mode: 0o500 });
  let rootParent = "0";
  let recursiveScans = 0;
  const { census: _census, ...withoutCensus } = f.deps;
  const deps: PortableDesktopHandoffDependencies = {
    ...withoutCensus,
    managerLauncher: () => manager,
    nodePid: () => 300,
    nodeParentPid: () => 200,
    prepareAccountContinuity: () => ({ state: "deferred", reason: "account-busy" }),
    readNativeThreadInventory: () => { throw new Error("busy native inventory must not be scanned"); },
    runCommand: (command, args) => {
      if (command === "/usr/bin/plutil") return { status: 0, stdout: "ChatGPT", stderr: "" };
      if (command === "/bin/ps" && args.includes("pid=,ppid=,command=")) return { status: 0, stderr: "", stdout: [
        `1 ${rootParent} /sbin/launchd`,
        "300 200 /usr/local/bin/node /private/manager/manager.mjs portable-desktop-prelaunch-v1",
        `200 100 ${manager} portable-desktop-prelaunch-v1`,
        `100 1 ${wrapper}`,
      ].join("\n") };
      if (command === "/bin/ps" && args.includes("pid=,command=")) return { status: 0, stderr: "", stdout: `100 ${wrapper}\n101 ${f.layout.official.appBundlePath}/Contents/MacOS/ChatGPT` };
      if (command === "/usr/sbin/lsof") recursiveScans += 1;
      throw new Error(`unexpected command ${command}`);
    },
  };
  const input = { target: "tweakers" as const, requireAuthenticatedPrelaunchWrapper: true };
  const postponed = runPortableDesktopHandoff(input, deps);
  assert.equal(postponed.status, "postponed");
  assert.deepEqual(postponed.accountContinuity, { state: "deferred", reason: "account-busy" });
  assert.equal(recursiveScans, 0);
  for (const invalid of ["-1", "invalid"]) {
    rootParent = invalid;
    assert.throws(() => runPortableDesktopHandoff(input, deps), /prelaunch-process-table-unreadable/);
  }
});

test("managed account continuity rebases from the signed donor only after two clean non-donor censuses", (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweakers-account-continuity-prelaunch-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  privateJson(join(root, "account-router-config.json"), { primaryOpaqueAccountId: "primary" });
  writeFileSync(join(root, "control-secret.v1"), Buffer.alloc(32, 7), { mode: 0o600 });
  chmodSync(join(root, "control-secret.v1"), 0o600);
  const donor = { opaqueAccountId: "native-donor", codexHome: join(root, "native"), sqliteHome: join(root, "native-sqlite") };
  const target = { opaqueAccountId: "primary", codexHome: join(root, "target"), sqliteHome: join(root, "target-sqlite") };
  const binding = { source: { metadataAccountId: donor.opaqueAccountId }, accounts: [donor, target] };
  let provenance = "primary";
  let shared = { fingerprint: "shared-before" };
  let plugins = { fingerprint: "plugins-before" };
  const census: Array<{ account: string; owned: readonly number[] }> = [];
  let rebases = 0;
  const history = {
    readAndPreflightNativeHistorySourceStaticV1: () => ({ state: "ready" as const, binding }),
    nativeHistoryBindingSafeV1: () => true,
    observeNativeAccountWritersV1: (_binding: unknown, account: string, owned: readonly number[]) => {
      census.push({ account, owned });
      return { ok: true, reason: "ready" as const, foreignPids: [] };
    },
  };
  const continuity = {
    DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1: {},
    loadSharedAccountBase: () => shared,
    loadSharedPluginsManifestV1: () => plugins,
    loadAccountContinuitySharedSourceProvenanceV1: () => ({ state: "ready" as const, sharedSourceOpaqueAccountId: provenance }),
    rebaseAccountContinuitySharedSource: (input: { accountWriteEvidence: Record<string, { nativeWriterCensus: () => string }> }) => {
      rebases += 1;
      assert.equal(input.accountWriteEvidence.primary.nativeWriterCensus(), "zero");
      assert.equal(input.accountWriteEvidence.primary.nativeWriterCensus(), "zero");
      provenance = donor.opaqueAccountId;
      shared = { fingerprint: "shared-after" };
      plugins = { fingerprint: "plugins-after" };
      return { state: "ready" as const, shared, plugins };
    },
  };
  const result = prepareManagedAccountContinuityPrelaunch(root, {
    resolveManagedRuntime: () => ({ root: join(root, "sealed"), fingerprint: "a".repeat(64) }),
    verifyManagedRuntime: () => undefined,
    requireModule: (path) => path.endsWith("native-history.js") ? history : continuity,
    recoveryPending: () => false,
  });

  assert.deepEqual(result, { state: "ready", reason: "shared-source-rebased" });
  assert.equal(rebases, 1);
  assert.ok(census.length >= 4, "two preflight censuses plus fresh runtime write closures are required");
  assert.deepEqual(census.slice(0, 2).map((entry) => entry.account), [target.opaqueAccountId, target.opaqueAccountId]);
  assert.ok(census.every((entry) => entry.account === target.opaqueAccountId));
  assert.ok(census.every((entry) => entry.owned.length === 0), "the authenticated wrapper is never broker-owned");
});

test("managed account continuity defers a busy target before donor scan but fails closed for pending recovery", (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweakers-account-continuity-busy-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  privateJson(join(root, "account-router-config.json"), { primaryOpaqueAccountId: "primary" });
  writeFileSync(join(root, "control-secret.v1"), Buffer.alloc(32, 9), { mode: 0o600 });
  chmodSync(join(root, "control-secret.v1"), 0o600);
  const binding = { source: { metadataAccountId: "donor" }, accounts: [
    { opaqueAccountId: "donor", codexHome: join(root, "donor"), sqliteHome: join(root, "donor-db") },
    { opaqueAccountId: "primary", codexHome: join(root, "target"), sqliteHome: join(root, "target-db") },
  ] };
  let rebases = 0;
  let writerReason: "foreign_writer" | "source_drift" = "foreign_writer";
  const history = {
    readAndPreflightNativeHistorySourceStaticV1: () => ({ state: "ready" as const, binding }),
    nativeHistoryBindingSafeV1: () => true,
    observeNativeAccountWritersV1: () => ({ ok: false, reason: writerReason, foreignPids: [44] }),
  };
  const continuity = {
    DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1: {},
    loadSharedAccountBase: () => ({ fingerprint: "shared" }),
    loadSharedPluginsManifestV1: () => ({ fingerprint: "plugins" }),
    loadAccountContinuitySharedSourceProvenanceV1: () => ({ state: "ready" as const, sharedSourceOpaqueAccountId: "primary" }),
    rebaseAccountContinuitySharedSource: () => { rebases += 1; return { state: "blocked" as const, reason: "must not run" }; },
  };
  const deps = {
    resolveManagedRuntime: () => ({ root: join(root, "sealed"), fingerprint: "b".repeat(64) }),
    verifyManagedRuntime: () => undefined,
    requireModule: (path: string) => path.endsWith("native-history.js") ? history : continuity,
  };
  assert.deepEqual(prepareManagedAccountContinuityPrelaunch(root, { ...deps, recoveryPending: () => false }), {
    state: "deferred", reason: "account-busy",
  });
  assert.equal(rebases, 0, "busy preflight never scans the donor or invokes the rebase primitive");
  writerReason = "source_drift";
  assert.deepEqual(prepareManagedAccountContinuityPrelaunch(root, { ...deps, recoveryPending: () => false }), {
    state: "deferred", reason: "source-changed",
  });
  writerReason = "foreign_writer";
  assert.throws(
    () => prepareManagedAccountContinuityPrelaunch(root, { ...deps, recoveryPending: () => true }),
    /cannot enter its recovery window: foreign_writer/,
  );
  assert.equal(rebases, 0);
});

test("managed account continuity is a no-op for the correct donor and blocks an unrecovered apply fault", (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweakers-account-continuity-recovery-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  privateJson(join(root, "account-router-config.json"), { primaryOpaqueAccountId: "primary" });
  writeFileSync(join(root, "control-secret.v1"), Buffer.alloc(32, 11), { mode: 0o600 });
  chmodSync(join(root, "control-secret.v1"), 0o600);
  const binding = { source: { metadataAccountId: "donor" }, accounts: [
    { opaqueAccountId: "donor", codexHome: join(root, "donor"), sqliteHome: join(root, "donor-db") },
    { opaqueAccountId: "primary", codexHome: join(root, "target"), sqliteHome: join(root, "target-db") },
  ] };
  let census = 0;
  let rebases = 0;
  let provenance = "donor";
  const history = {
    readAndPreflightNativeHistorySourceStaticV1: () => ({ state: "ready" as const, binding }),
    nativeHistoryBindingSafeV1: () => true,
    observeNativeAccountWritersV1: () => { census += 1; return { ok: true, reason: "ready" as const, foreignPids: [] }; },
  };
  const continuity = {
    DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1: {},
    loadSharedAccountBase: () => ({ fingerprint: "shared" }),
    loadSharedPluginsManifestV1: () => ({ fingerprint: "plugins" }),
    loadAccountContinuitySharedSourceProvenanceV1: () => ({ state: "ready" as const, sharedSourceOpaqueAccountId: provenance }),
    rebaseAccountContinuitySharedSource: () => { rebases += 1; return { state: "blocked" as const, reason: "injected apply fault" }; },
  };
  const deps = {
    resolveManagedRuntime: () => ({ root: join(root, "sealed"), fingerprint: "c".repeat(64) }),
    verifyManagedRuntime: () => undefined,
    requireModule: (path: string) => path.endsWith("native-history.js") ? history : continuity,
    recoveryPending: () => false,
  };
  assert.deepEqual(prepareManagedAccountContinuityPrelaunch(root, deps), { state: "ready", reason: "already-current" });
  assert.equal(census, 0);
  assert.equal(rebases, 0);
  provenance = "primary";
  assert.throws(() => prepareManagedAccountContinuityPrelaunch(root, deps), /requires recovery: injected apply fault/);
  assert.equal(rebases, 2, "one bounded recovery attempt follows the failed apply");
});

test("shared native prelaunch selects verified reference mode without entering legacy copying", (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweakers-shared-native-prelaunch-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  privateJson(join(root, "account-router-config.json"), { primaryOpaqueAccountId: "primary" });
  writeFileSync(join(root, "control-secret.v1"), Buffer.alloc(32, 9), { mode: 0o600 });
  privateJson(join(root, "shared-native-mode.v1.json"), { version: 1 });
  const binding = { source: { metadataAccountId: "donor" }, accounts: [
    { opaqueAccountId: "primary", codexHome: join(root, "primary"), sqliteHome: join(root, "primary-db") },
    { opaqueAccountId: "donor", codexHome: join(root, "donor"), sqliteHome: join(root, "donor-db") },
  ] };
  const history = {
    readAndPreflightNativeHistorySourceStaticV1: () => ({ state: "ready" as const, binding }),
    nativeHistoryBindingSafeV1: () => true,
    observeNativeAccountWritersV1: () => { throw new Error("legacy writer check must not run"); },
  };
  const legacy = () => { throw new Error("legacy copying must not run"); };
  const continuity = {
    loadSharedAccountBase: legacy, loadSharedPluginsManifestV1: legacy,
    loadAccountContinuitySharedSourceProvenanceV1: legacy, rebaseAccountContinuitySharedSource: legacy,
  };
  let modeState = "ready";
  const mode = { readSharedNativeModeV1: (context: { stateRoot: string; binding: unknown; secret: Buffer }) => {
    assert.equal(context.stateRoot, root);
    assert.equal(context.binding, binding);
    assert.equal(context.secret.length, 32);
    return { state: modeState, reason: "transition pending" };
  } };
  const deps = {
    resolveManagedRuntime: () => ({ root: join(root, "sealed"), fingerprint: "a".repeat(64) }),
    verifyManagedRuntime: () => undefined,
    requireModule: (path: string) => path.endsWith("native-history.js") ? history
      : path.endsWith("shared-native-mode.js") ? mode : continuity,
  };
  assert.deepEqual(prepareManagedAccountContinuityPrelaunch(root, deps), { state: "ready", reason: "shared-native-ready" });
  modeState = "blocked";
  assert.throws(() => prepareManagedAccountContinuityPrelaunch(root, deps), /transition pending/);
});

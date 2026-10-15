import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { extractFile, listPackage } from "@electron/asar";
import {
  createDerivedNativeServicePolicy,
  patchCodexNativeServicePolicySource,
  patchCodexNativeServicePolicyInExtractedApp,
  type DerivedNativeServiceBindings,
} from "../src/codex-native-service-policy.js";

function fixture() {
  const effects = { spawn: 0, native: 0, writes: 0, plugins: 0, workers: 0, pending: 0, register: 0 };
  const stored = { appshotsEnabled: true, computerUse: true, computerUseAutoInstall: true, skysight: true, appshotHotkey: "Alt+Space", git: true };
  class Managed {
    appshotsEnabled = false; computerUseEnabled = false; skysightEnabled = false;
    setAppshotsEnabled() { effects.native++; }
    setEnabledFeatures() { effects.native++; }
    async ensureServicePid() { effects.spawn++; }
    async ensureServicePidForEnabledFeatures() { effects.spawn++; }
  }
  class Chronicle {
    async getState() { effects.native++; }
    async retryActivation() { effects.native++; }
    async setEnabled() { effects.writes++; }
    async pause() { effects.native++; }
    async resume() { effects.native++; }
    async getSettings() { effects.native++; }
    async updateSettings() { effects.writes++; }
    async listApplications() { effects.native++; }
    async resolveApplications() { effects.native++; }
    async listHistory() { effects.native++; }
    async listHistorySuggestions() { effects.native++; }
    async listHistorySummaryIntervals() { effects.native++; }
    async clearHistory() { effects.writes++; }
  }
  class Appshot {
    setHotkey() { effects.writes++; }
    async requestFinalUpdate() { effects.native++; }
  }
  class Hotkeys {
    enabled: boolean;
    configuredHotkey = stored.appshotHotkey;
    constructor(enabled: boolean) { this.enabled = enabled; if (this.getState().supported) effects.register++; }
    getState() { return { supported: this.enabled, configuredHotkey: this.configuredHotkey, isActive: this.enabled }; }
    setEnabled(enabled: boolean) { this.enabled = enabled; effects.register++; }
    setHotkey() { effects.writes++; }
  }
  class WorkerManager {
    constructor(public id: string) {}
    ensureWorker() { effects.workers++; return "worker"; }
  }
  class WorkerBus {
    constructor(public workerId: string) {}
    async handleMessage() { effects.pending++; effects.workers++; }
    requestFromHost() { effects.pending++; effects.workers++; return Promise.resolve("response"); }
  }
  let receivedFlags: Record<string, unknown> = {};
  let receivedConfig: Record<string, unknown> = {};
  const bindings: DerivedNativeServiceBindings = {
    initialState: stored,
    featureTransform: (flags: Record<string, unknown>) => ({ ...flags, computerUse: true, skysight: true }),
    featureStore: (flags: Record<string, unknown>) => { receivedFlags = flags; return true; },
    pluginReconciler: () => { effects.plugins++; throw Error("must never construct bundled reconciler"); },
    spawn: async () => { effects.spawn++; return 100; },
    nodeReplConfig: (config: Record<string, unknown>) => { receivedConfig = config; return config; },
    workerFactory: () => ({ requestComputerUseWorker: async () => { effects.workers++; }, requestComputerUseCaptureUpdate: async () => { effects.workers++; }, requestGitWorker: () => "git" }),
    managedService: Managed, chronicleFacade: Chronicle, appshotFacade: Appshot,
    appshotHotkeys: Hotkeys, workerManager: WorkerManager, workerBus: WorkerBus,
  };
  // Compile only the serialized factory: no imported closure is available in this realm.
  const factory = vm.runInThisContext(`((__name)=>(${createDerivedNativeServicePolicy.toString()}))((fn)=>fn)`) as typeof createDerivedNativeServicePolicy;
  return { effects, stored, bindings, policy: factory(bindings), Managed, Chronicle, Appshot, Hotkeys, WorkerManager, WorkerBus,
    flags: () => receivedFlags, config: () => receivedConfig };
}

test("derived policy masks initial, transformed and stored-input flags without changing persisted settings", () => {
  const f = fixture();
  const expected = { ...f.stored, appshotsEnabled: false, computerUse: false, computerUseAutoInstall: false, skysight: false };
  assert.deepEqual(f.policy.initialState, expected);
  assert.deepEqual(f.policy.featureTransform(f.stored), expected);
  assert.equal(f.policy.featureStore(f.stored), true);
  assert.deepEqual(f.flags(), expected);
  assert.equal(f.stored.appshotsEnabled, true);
  assert.equal(f.stored.skysight, true);
  f.policy.nodeReplConfig({ computerUse: true, inAppBrowserUse: true });
  assert.deepEqual(f.config(), { computerUse: false, inAppBrowserUse: true });
});

test("bundled plugin ownership and native service calls have no side effects", async () => {
  const f = fixture();
  const plugins = f.policy.pluginReconciler({ getLocalAppServerConnection: () => { throw Error("not shared"); } });
  assert.equal(Object.keys(plugins).length, 6);
  for (const method of Object.values(plugins)) await method(true);
  const managed = new f.Managed();
  await managed.setAppshotsEnabled();
  await managed.setEnabledFeatures();
  await assert.rejects(() => managed.ensureServicePid(), /unavailable in Tweakers/);
  await assert.rejects(() => managed.ensureServicePidForEnabledFeatures(), /unavailable in Tweakers/);
  await assert.rejects(() => f.policy.spawn(), /unavailable in Tweakers/);
  assert.equal(f.effects.spawn, 0);
  assert.equal(f.effects.native, 0);
  assert.equal(f.effects.plugins, 0);
});

test("computer-use workers reject before queue mutation while git and open-in workers remain operational", async () => {
  const f = fixture();
  assert.throws(() => new f.WorkerManager("computer-use").ensureWorker(), /unavailable in Tweakers/);
  const bus = new f.WorkerBus("computer-use");
  await assert.rejects(() => bus.requestFromHost(), /unavailable in Tweakers/);
  await assert.rejects(() => bus.handleMessage(), /unavailable in Tweakers/);
  const workers = f.policy.workerFactory({});
  await assert.rejects(() => workers.requestComputerUseWorker(), /unavailable in Tweakers/);
  await assert.rejects(() => workers.requestComputerUseCaptureUpdate(), /unavailable in Tweakers/);
  assert.equal(f.effects.pending, 0);
  assert.equal(f.effects.workers, 0);
  assert.equal(workers.requestGitWorker(), "git");
  for (const id of ["git", "open-in", "custom-plugin-worker"]) {
    assert.equal(new f.WorkerManager(id).ensureWorker(), "worker");
    assert.equal(await new f.WorkerBus(id).requestFromHost(), "response");
  }
  assert.equal(f.effects.pending, 3);
  assert.equal(f.effects.workers, 6);
});

test("Chronicle and Appshot operations report unavailable and preserve the native shortcut", async () => {
  const f = fixture();
  const chronicle = new f.Chronicle();
  for (const name of ["getState", "retryActivation", "setEnabled", "pause", "resume", "getSettings", "updateSettings", "listApplications", "resolveApplications", "listHistory", "listHistorySuggestions", "listHistorySummaryIntervals", "clearHistory"] as const) {
    await assert.rejects(() => chronicle[name](), /unavailable in Tweakers/);
  }
  const appshot = new f.Appshot();
  await assert.rejects(() => appshot.requestFinalUpdate(), /unavailable in Tweakers/);
  assert.throws(() => appshot.setHotkey(), /unavailable in Tweakers/);
  const hotkeys = new f.Hotkeys(true);
  await hotkeys.setEnabled(true);
  assert.deepEqual(hotkeys.getState(), { supported: false, configuredHotkey: "Alt+Space", isActive: false });
  assert.throws(() => hotkeys.setHotkey(), /unavailable in Tweakers/);
  assert.equal(f.effects.register, 0);
  assert.equal(f.effects.writes, 0);
  assert.equal(f.effects.native, 0);
  assert.equal(f.stored.appshotHotkey, "Alt+Space");
});

// A live app path can now contain another build. Missing version-specific
// entries mean that fixture is absent; changed fixture contents still fail.
function hasVendorEntry(archive: string, entry: string): boolean {
  return existsSync(archive) && listPackage(archive, { isPack: false }).includes(`/${entry}`);
}

const vendorInputs = [
  { name: "native20398", archive: process.env.TWEAKERS_TEST_20398_ASAR ?? "/Users/thomashulihan/Library/Application Support/Tweakers/official-source/baselines/6142fb65-40d4-4092-96dc-439d0ef161e0/resources/app.asar", entry: ".vite/build/main-CwxgTOle.js" },
  { name: "native20156", archive: "/Users/thomashulihan/Library/Application Support/Tweakers/official-source/baselines/0ba76dd5-6b9a-4bc1-b4c1-7c867e02e4d6/resources/app.asar", entry: ".vite/build/main-CqEoQDOU.js" },
  { name: "native20052", archive: "/Applications/ChatGPT.app/Contents/Resources/app.asar", entry: ".vite/build/main-39FdJ_vp.js" },
  { name: "native12947", archive: "/Applications/ChatGPT.app/Contents/Resources/app.asar", entry: ".vite/build/main-lQ71Zm1D.js" },
  { name: "Tweakers10954 pristine", archive: "/Users/thomashulihan/Library/Application Support/Tweakers/official-source/baselines/4db27387-c636-4b0e-bcc7-e74720091081/resources/app.asar", entry: ".vite/build/main-C-Mhak1n.js" },
  { name: "Tweakers10954 installed", archive: "/Applications/Tweakers.app/Contents/Resources/app.asar", entry: ".vite/build/main-C-Mhak1n.js" },
];
for (const vendor of vendorInputs) {
  test(`reviewed source profile accepts ${vendor.name}, refuses tampering and is idempotent`, { skip: !hasVendorEntry(vendor.archive, vendor.entry) && "matching local vendor build is unavailable" }, () => {
    const source = extractFile(vendor.archive, vendor.entry).toString("utf8");
    const patched = patchCodexNativeServicePolicySource(source);
    assert.equal(patched.changed, true);
    const again = patchCodexNativeServicePolicySource(patched.source);
    assert.equal(again.changed, false);
    assert.equal(again.source, patched.source);
    assert.throws(() => patchCodexNativeServicePolicySource(source + source), /ambiguous|unsupported/);
    assert.throws(() => patchCodexNativeServicePolicySource(source.replace("spawnComputerUseService(e)", "spawnComputerUseService(e, true)")), /fingerprint|unsupported/);
    assert.throws(() => patchCodexNativeServicePolicySource(patched.source.replace("spawnComputerUseService(e)", "spawnComputerUseService(e, true)")), /fingerprint|unsupported/);
  });
}

test("unknown vendor source cannot construct a derived policy", () => {
  assert.throws(() => patchCodexNativeServicePolicySource("function unknownBoot() {}"), /unsupported/);
});

const vendorEntryChains = [
{
  "build": "20398",
  "archive": "/Users/thomashulihan/Library/Application Support/Tweakers/official-source/baselines/6142fb65-40d4-4092-96dc-439d0ef161e0/resources/app.asar",
  "files": [
    {
      "path": ".vite/build/early-bootstrap.js",
      "sha256": "036bde993c50a1a34d0f7a0ee4f3d57b5592b4cfe3b2a87b4022b263bf0367aa"
    },
    {
      "path": ".vite/build/bootstrap-DOZRFVdo.js",
      "sha256": "8602f1022fc835148268e8cdfcfb939d8ab5a969e4fd0b4141e264ce8ec4be4d"
    }
  ],
  "main": ".vite/build/main-CwxgTOle.js"
},
  {
    "build": "20156",
    "archive": "/Users/thomashulihan/Library/Application Support/Tweakers/official-source/baselines/0ba76dd5-6b9a-4bc1-b4c1-7c867e02e4d6/resources/app.asar",
    "files": [
      {
        "path": ".vite/build/early-bootstrap.js",
        "sha256": "36b8494989d89f9b063a27f10b60119243c8e4cc8abd2ef8a9743c507d15019c"
      },
      {
        "path": ".vite/build/bootstrap-CooIJpZm.js",
        "sha256": "d1ab6d0bb5aabf4d56a3cb39d979dc1145e41b47be6821b967cba3802af3fbf0"
      }
    ],
    "main": ".vite/build/main-CqEoQDOU.js"
  },
  {
    "build": "20052",
    "archive": "/Applications/ChatGPT.app/Contents/Resources/app.asar",
    "files": [
      {
        "path": ".vite/build/early-bootstrap.js",
        "sha256": "24286bb6b5fe449e6d4f1b8cfc061c35be57e54fe4ea0802b3e257f32c45fc33"
      },
      {
        "path": ".vite/build/bootstrap-Du6FqCuH.js",
        "sha256": "7c8665efb642d0683d42bb0c2b4ac6c80bfd3c19eecd0fa0ee5a8a9934fa17c4"
      }
    ],
    "main": ".vite/build/main-39FdJ_vp.js"
  },
  {
    "build": "10954",
    "archive": "/Users/thomashulihan/Library/Application Support/Tweakers/official-source/baselines/4db27387-c636-4b0e-bcc7-e74720091081/resources/app.asar",
    "files": [
      {
        "path": ".vite/build/early-bootstrap.js",
        "sha256": "5df795f25c3541029b9e90b205767fbc76da559864bd3df1f00d6eee97179edc"
      },
      {
        "path": ".vite/build/bootstrap-C4dRql4x.js",
        "sha256": "0757af0981f4552ca79ed1a364eafa6a73e71a92e65ea4fce747c7b6c715ed4a"
      }
    ],
    "main": ".vite/build/main-C-Mhak1n.js"
  },
  {
    "build": "12947",
    "archive": "/Applications/ChatGPT.app/Contents/Resources/app.asar",
    "files": [
      {
        "path": ".vite/build/early-bootstrap.js",
        "sha256": "57b58f5aa3b268487a9410ae83626daefde98d604fe608827a64e9f1c7727784"
      },
      {
        "path": ".vite/build/bootstrap-D3_zvIvQ.js",
        "sha256": "35d486c724973490ad66921f6a451ac6aa59d14e31f977f0486ef9574976177e"
      }
    ],
    "main": ".vite/build/main-lQ71Zm1D.js"
  },
  {
    "build": "13022",
    "archive": "/Users/thomashulihan/Library/Application Support/Tweakers/doctor/jobs/e87ac5b4-f063-4258-955b-81d2c18d1d90/upstream/extracted/ChatGPT.app/Contents/Resources/app.asar",
    "files": [
      {
        "path": ".vite/build/early-bootstrap.js",
        "sha256": "1ef64d429d6399c51d8f2042652925a1e586ac8c70f3b0c156203f894574dd7b"
      },
      {
        "path": ".vite/build/bootstrap-D18rbfeM.js",
        "sha256": "d51325ac1db018c4cd867225c0efe5cded678268cd9eee9270d05dfd48f4bcad"
      }
    ],
    "main": ".vite/build/main-vwle0m1s.js"
  }
];
for (const vendor of vendorEntryChains) {
  test(`derived guard follows the reviewed ${vendor.build} bootstrap chain and rejects changed entry code`, { skip: !hasVendorEntry(vendor.archive, vendor.main) && "matching local vendor build is unavailable" }, () => {
    const root = mkdtempSync(join(tmpdir(), "tweakers-entry-policy-"));
    try {
      for (const entry of [...vendor.files.map(file => file.path), vendor.main, ...(vendor.build === "20398" ? [".vite/build/startup-requirements-CYrrMBwA.js"] : vendor.build === "20156" ? [".vite/build/startup-requirements-C6B1x9gL.js"] : [])]) {
        const path = join(root, entry);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, extractFile(vendor.archive, entry));
      }
      const entry = vendor.files[0]!.path;
      const entryBefore = readFileSync(join(root, entry), "utf8");
      const mainBefore = readFileSync(join(root, vendor.main), "utf8");
      assert.equal(patchCodexNativeServicePolicyInExtractedApp(root, entry).changed, true);
      assert.equal(readFileSync(join(root, entry), "utf8"), entryBefore);
      assert.notEqual(readFileSync(join(root, vendor.main), "utf8"), mainBefore);
      assert.equal(patchCodexNativeServicePolicyInExtractedApp(root, entry).changed, false);
      writeFileSync(join(root, vendor.files[1]!.path), "/* unknown entry behavior */" + readFileSync(join(root, vendor.files[1]!.path), "utf8"));
      assert.throws(() => patchCodexNativeServicePolicyInExtractedApp(root, entry), /unsupported.*bootstrap/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

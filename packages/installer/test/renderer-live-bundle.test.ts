/**
 * Runs the renderer matchers against the real installed ChatGPT bundle.
 *
 * Until this existed, no test had ever fed a patcher actual renderer bytes —
 * every fixture was written by the same person who wrote the pattern, so a
 * matcher could pin a minified identifier and stay green forever while being
 * one desktop update away from breaking every mode switch. That is exactly how
 * 2026-08-10 happened.
 *
 * No vendor bytes are committed: `origin` is public. The bundle is resolved at
 * run time and the suite skips when it is absent (CI, fresh clones).
 */
import assert from "node:assert/strict";
import { extractFile, listPackage } from "@electron/asar";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateAccountsNativeCompatibility } from "@therealityreport/tweakers-sdk";
import { nativeBootstrapSource, patchCodexAccountsNativeSources } from "../src/codex-accounts-native";
import { ACCOUNTS_NATIVE_MAIN_PATH, ACCOUNTS_NATIVE_SHARED_PATH, nativeAccountsConsumerPreservationSource, nativeAccountsDesktopProjectsSource, nativeAccountsMainRegistrationSource } from "../src/codex-accounts-native-main";
import { patchCodexInactiveThreadRetentionSource } from "../src/codex-inactive-thread-retention";
import { patchCodexModelSelectionSource } from "../src/codex-model-selection";
import { patchCodexWindowServicesSource } from "../src/codex-window-services";
import { RendererPatchDeclined } from "../src/renderer-patch-outcome";

const LIVE_ASAR = "/Applications/ChatGPT.app/Contents/Resources/app.asar";
const available = existsSync(LIVE_ASAR);

function rendererSources(pattern = /^[/\\]webview[/\\]assets[/\\]app-initial-[^/\\]*\.js$/): Array<{ path: string; source: string }> {
  return listPackage(LIVE_ASAR)
    .filter((entry) => pattern.test(entry))
    .map((entry) => {
      const relativePath = entry.replace(/^[/\\]/, "");
      return { path: relativePath, source: extractFile(LIVE_ASAR, relativePath).toString("utf8") };
    });
}

test("the live renderer still exposes an app-initial bundle", { skip: !available }, () => {
  const sources = rendererSources();
  assert.ok(sources.length > 0, "no app-initial-*.js found in the installed bundle");
});

test("the inactive-thread retention policy resolves in the live bundle", { skip: !available }, () => {
  const outcomes = rendererSources().map(({ path, source }) => {
    try {
      return { path, patch: patchCodexInactiveThreadRetentionSource(source), error: null as unknown };
    } catch (error) {
      return { path, patch: null, error };
    }
  });

  const failed = outcomes.filter((outcome) => outcome.error);
  assert.equal(
    failed.length,
    0,
    `patcher refused the live bundle: ${failed
      .map((f) => `${f.path}: ${(f.error as Error).message}`)
      .join("; ")}`,
  );

  const matched = outcomes.filter((outcome) => outcome.patch);
  assert.equal(matched.length, 1, "expected exactly one renderer asset to carry the retention policy");

  const patch = matched[0]?.patch;
  assert.ok(patch);
  // The installed app may already be patched (Tweakers mode) or pristine
  // (ChatGPT mode); both are healthy, a refusal is not.
  assert.ok(
    patch.strategy === "telemetry-key-discovery" || patch.strategy === "already-patched",
    `unexpected strategy ${patch.strategy}`,
  );
});

test("the retention patch is idempotent against the live bundle", { skip: !available }, () => {
  const carrier = rendererSources()
    .map(({ source }) => ({ source, patch: patchCodexInactiveThreadRetentionSource(source) }))
    .find((candidate) => candidate.patch);
  assert.ok(carrier?.patch);

  const once = carrier.patch.changed ? carrier.patch.source : carrier.source;
  const again = patchCodexInactiveThreadRetentionSource(once);
  assert.ok(again);
  assert.equal(again.changed, false);
  assert.equal(again.strategy, "already-patched");
});

test("the model selector never refuses the live bundle outright", { skip: !available }, () => {
  // not-applicable is acceptable here (the selector may live in a lazily
  // imported chunk this test does not walk); a decline or a hard throw is not.
  for (const { path, source } of rendererSources()) {
    try {
      patchCodexModelSelectionSource(source);
    } catch (error) {
      if (error instanceof RendererPatchDeclined) {
        assert.fail(`model selector declined the live bundle in ${path}: ${error.message}`);
      }
      throw error;
    }
  }
});

test("Accounts patches the actual native screens atomically and its receipt verifies every asset", { skip: !available }, () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/)
    .map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  assert.equal(patched.changed, true);
  assert.equal(patched.record.assets.length, 8);
  for (const asset of patched.record.assets) {
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: patched.sources.get(asset.path)!, encoding: "utf8", maxBuffer: 1024 * 1024 });
    assert.equal(syntax.status, 0, `${asset.path}: ${syntax.stderr}`);
  }
  const nativeMain = patched.sources.get(ACCOUNTS_NATIVE_MAIN_PATH)!;
  const writeStart = nativeMain.indexOf("async runProjectWrite(e,t,n)");
  const writeEnd = nativeMain.indexOf("async writeAppServerProject(", writeStart);
  const writeHandler = nativeMain.slice(writeStart, writeEnd);
  assert.ok(writeStart >= 0 && writeEnd > writeStart);
  assert.ok(writeHandler.includes("async()=>{r.throwIfAborted(),await __twAccountsDesktopProjects.ensureWrite(this),r.throwIfAborted(),this.projectSupport"), "queued native project writes must verify the current projection inside their serialized callback");
  assert.ok(writeHandler.indexOf("await __twAccountsDesktopProjects.ensureWrite(this)") < writeHandler.indexOf("await t(r)"), "native project writes must verify the current projection before their first RPC");
  const hash = (source: string) => createHash("sha256").update(source).digest("hex");
  assert.equal(validateAccountsNativeCompatibility(patched.record, (path) => patched.sources.get(path)!, hash).compatible, true);
  const again = patchCodexAccountsNativeSources(patched.sources, patched.record);
  assert.equal(again.changed, false);
  assert.deepEqual(again.sources, patched.sources);

  // Exercise the installer's actual patch order as well as pristine native bytes.
  const prepared = new Map(sources);
  const windowServices = patchCodexWindowServicesSource(prepared.get(ACCOUNTS_NATIVE_MAIN_PATH)!);
  assert.equal(windowServices?.changed, true);
  prepared.set(ACCOUNTS_NATIVE_MAIN_PATH, windowServices!.source);
  for (const [assetPath, source] of prepared) {
    if (!assetPath.startsWith("webview/")) continue;
    const model = patchCodexModelSelectionSource(source);
    const selected = model?.source ?? source;
    prepared.set(assetPath, patchCodexInactiveThreadRetentionSource(selected)?.source ?? selected);
  }
  const composed = patchCodexAccountsNativeSources(prepared);
  assert.equal(composed.record.status, "compatible", composed.record.reason);
  assert.equal(validateAccountsNativeCompatibility(composed.record, (path) => composed.sources.get(path)!, hash).compatible, true);
  assert.deepEqual(patchCodexAccountsNativeSources(composed.sources, composed.record).sources, composed.sources);
  for (const asset of composed.record.assets) {
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: composed.sources.get(asset.path)!, encoding: "utf8", maxBuffer: 1024 * 1024 });
    assert.equal(syntax.status, 0, `${asset.path}: ${syntax.stderr}`);
  }

  const changed = new Map(patched.sources);
  const asset = patched.record.assets[0].path;
  changed.set(asset, changed.get(asset)! + "\n");
  assert.equal(validateAccountsNativeCompatibility(patched.record, (path) => changed.get(path)!, hash).compatible, false);
  assert.equal(patchCodexAccountsNativeSources(changed, patched.record).record.status, "unavailable");
  assert.equal(validateAccountsNativeCompatibility({ ...patched.record, assets: patched.record.assets.slice(1) }, (path) => patched.sources.get(path)!, hash).compatible, false);

  const duplicate = new Map(sources);
  duplicate.set("webview/assets/app-primary-ffffffffffff.js", sources.get("webview/assets/app-primary-e25aaf15dbaf.js")!);
  const refused = patchCodexAccountsNativeSources(duplicate);
  assert.equal(refused.record.status, "unavailable");
  assert.equal(refused.changed, false);
  assert.deepEqual(refused.sources, duplicate, "a declined patch must preserve every native byte");
  const drift = new Map(sources);
  drift.set(asset, drift.get(asset)! + "\n");
  assert.equal(patchCodexAccountsNativeSources(drift).record.status, "unavailable");
});

test("native browser helpers receive the selected account home through the actual native sync functions", { skip: !available }, async () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/).map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  const main = patched.sources.get(ACCOUNTS_NATIVE_MAIN_PATH)!;
  const sync = main.slice(main.indexOf("async function Ms("), main.indexOf("function Ns("));
  const selection = main.slice(main.indexOf("async function Eo("), main.indexOf("function Do("));
  const homes: string[] = [];
  const calls: string[] = [];
  const page: any = {
    n: { yi: () => false, ci: () => { throw new Error("wrong native account home"); }, hc: () => "openai-bundled", vc: "cua_repl",
      in: async (options: any) => { homes.push(options.codexHome); }, on: async (options: any) => { assert.equal(options.preserveRetainedConsumers, true); homes.push(options.codexHome); } },
    a: { i: { resolve: () => "/app" } }, s: { g: { marketplaceKinds: ["local"] } },
    U: () => ({ browserUseTinysky: true }), Do: () => {}, Zr: () => ({ platform: "darwin" }),
    Si: () => false, Ci: () => ({ serviceAppPath: null }), Zte: () => false,
    bs: async () => ({}), Di: async (options: any) => { homes.push(options.codexHome); return false; },
    Jte: async (options: any) => { homes.push(options.codexHome); }, Ai: () => "/resources", Ns: () => [],
    wi: { "mcp_servers.cua_repl": { enabled: false } },
    l: { app: { getVersion: () => "26.903.61454", isPackaged: true } }, process: { resourcesPath: "/resources" },
  };
  runInNewContext(`${selection};${sync};var As=class {constructor(options){this.options=options}syncAfterPluginChange(){return Ms(this.options)}};${nativeAccountsMainRegistrationSource(patched.record.hookSetSha256)}`, page);
  const bridge = page.__tweakersAccountsNativeMainV1.create({ codexHome: "/selected/account-b", appServerVersion: "0.153.4", assertCurrent: () => {},
    request: async (method: string) => { calls.push(method); return method === "plugin/list" ? { marketplaces: [] } : { status: "ok" }; } });
  await bridge.sync();
  await bridge.install({ hostId: "local", marketplacePath: "/selected/marketplace", pluginName: "chrome" });
  await bridge.uninstall({ hostId: "local", marketplaceName: "openai-bundled", pluginName: "chrome" });
  assert.deepEqual(homes, Array(4).fill("/selected/account-b"));
  assert.deepEqual(calls, ["plugin/list", "config/batchWrite"]);
});

test("native desktop projects bind the connection home, preserve edits, and fail closed across refresh generations", async () => {
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  let onFocus = () => {};
  const values: Record<string, any> = {
    "remote-projects": [{ id: "remote", name: "Remote" }],
    "thread-project-assignments": { "thread-remote": { projectKind: "remote", projectId: "remote" } },
    "project-order": ["remote"], "pinned-project-ids": ["remote"],
    "sidebar-project-thread-orders": { remote: { threadIds: ["thread-remote"] } },
    "project-appearances": { remote: { color: "purple" } },
  };
  const store = {
    get(key: string) { return values[key]; },
    getStored(key: string) { return values[key]; },
    set(key: string, value: any) { values[key] = structuredClone(value); },
  };
  const projections = [
    { version: 1, values: { "local-projects": { "legacy-a": { id: "legacy-a", name: "A", rootPaths: ["/a"], createdAt: 0, updatedAt: 0 } }, "thread-project-assignments": { "thread-a": { projectKind: "local", projectId: "legacy-a" } }, "project-order": ["legacy-a"], "pinned-project-ids": [], "sidebar-project-thread-orders": { "legacy-a": { threadIds: ["thread-a"] } }, "electron-saved-workspace-roots": ["/a"], "electron-workspace-root-labels": { "/a": "A" }, "project-appearances": {} }, projectIdMap: { "legacy-a": "native-a" } },
    new Error("temporary read failure"),
    { version: 1, values: { "local-projects": { "legacy-a": { id: "legacy-a", name: "A from server", rootPaths: ["/a"], createdAt: 0, updatedAt: 0 }, "native-c": { id: "native-c", name: "C", rootPaths: ["/c"], createdAt: 0, updatedAt: 0 } }, "thread-project-assignments": {}, "project-order": ["legacy-a", "native-c"], "pinned-project-ids": [], "sidebar-project-thread-orders": {}, "electron-saved-workspace-roots": ["/a", "/c"], "electron-workspace-root-labels": {}, "project-appearances": {} }, projectIdMap: { "legacy-a": "native-a", "native-c": "native-c" } },
  ];
  projections.push(structuredClone(projections[2]!), structuredClone(projections[2]!));
  let reads = 0;
  const connection = { codexHome: async () => "/connection-home", sendAppServerRequest: async () => { const result = projections[reads++]; if (result instanceof Error) throw result; return structuredClone(result); } };
  const page: any = { Buffer, __tweakersAccountsDesktopProjectsEnabledV1: () => true, n: { ci: () => "/fallback-home" }, l: { app: { on: (_event: string, listener: () => void) => { onFocus = listener; } } } };
  runInNewContext(nativeAccountsDesktopProjectsSource(), page);
  const projects = page.__twAccountsDesktopProjects;
  await projects.ensureBackend({ cache: { hostId: "local" }, globalState: store, connection }, "/connection-home");
  assert.deepEqual(plain(store.get("app-server-project-id-by-legacy-project-id-by-host")), { "local:/connection-home": { "legacy-a": "native-a" } });
  assert.deepEqual(plain(store.get("project-order")), ["remote", "legacy-a"]);
  assert.deepEqual(plain(store.get("pinned-project-ids")), ["remote"]);
  assert.equal(store.get("project-appearances").remote.color, "purple");
  store.set("app-server-project-id-by-legacy-project-id-by-host", { "local:/connection-home": { "legacy-a": "native-a", "legacy-c": "native-c" } });
  store.set("local-projects", {
    "legacy-a": { ...store.get("local-projects")["legacy-a"], name: "Renamed locally" },
    "legacy-c": { id: "legacy-c", name: "C", rootPaths: ["/c"], createdAt: 1, updatedAt: 1 },
  });
  store.set("thread-project-assignments", { "thread-remote": { projectKind: "remote", projectId: "remote" }, "thread-c": { projectKind: "local", projectId: "legacy-c" } });
  store.set("project-order", ["remote", "legacy-c", "legacy-a"]);
  onFocus();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get("local-projects")["legacy-a"].name, "Renamed locally", "last verified projection and local delta survive a transient failure");
  assert.deepEqual(plain(store.get("project-order")), ["remote", "legacy-c", "legacy-a"]);
  assert.throws(() => store.set("pinned-project-ids", ["legacy-a"]), /changes are disabled/);
  await assert.rejects(projects.ensureWrite({ cache: { hostId: "local" }, globalState: store, connection }), /initialization will retry/, "native write entry is blocked before its RPC while refresh is unverified");
  onFocus();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get("local-projects")["legacy-a"].name, "Renamed locally");
  assert.deepEqual(plain(store.get("thread-project-assignments")), { "thread-remote": { projectKind: "remote", projectId: "remote" }, "thread-c": { projectKind: "local", projectId: "legacy-c" } });
  store.set("app-server-project-id-by-legacy-project-id-by-host", store.get("app-server-project-id-by-legacy-project-id-by-host"));
  onFocus();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plain(store.get("app-server-project-id-by-legacy-project-id-by-host")), { "local:/connection-home": { "legacy-a": "native-a", "legacy-c": "native-c" } }, "a no-op native map write preserves the durable local alias");
  assert.equal(store.get("local-projects")["legacy-c"].name, "C");
  assert.equal(store.get("thread-project-assignments")["thread-c"].projectId, "legacy-c");
  store.set("app-server-project-id-by-legacy-project-id-by-host", { "local:/connection-home": { "legacy-c": "native-c" } });
  assert.deepEqual(plain(store.get("app-server-project-id-by-legacy-project-id-by-host")), { "local:/connection-home": { "legacy-c": "native-c" } }, "nested mapping removals are exact");
  assert.equal(store.get("local-projects")["legacy-a"], undefined, "native delete stays removed");
  store.set("project-order", ["remote", "legacy-c"]);
  assert.deepEqual(plain(store.get("project-order")), ["remote", "legacy-c"]);
  store.set("local-projects", {});
  store.set("app-server-project-id-by-legacy-project-id-by-host", { "local:/connection-home": {} });
  assert.deepEqual(plain(store.get("app-server-project-id-by-legacy-project-id-by-host")), { "local:/connection-home": {} });
  assert.deepEqual(Object.keys(store.get("local-projects")), []);
  onFocus();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plain(store.get("app-server-project-id-by-legacy-project-id-by-host")), { "local:/connection-home": {} }, "deleted local alias stays removed when reconnect reports its native public ID");
  assert.deepEqual(Object.keys(store.get("local-projects")), []);
  assert.deepEqual(plain(store.get("project-order")), ["remote"], "remote project order survives local deletion");
  assert.equal(store.get("project-appearances").remote.color, "purple");
});

test("native desktop projects expose unavailable startup and discard late replies after reconnect", async () => {
  let onFocus = () => {};
  const values: Record<string, any> = {};
  const store = { get: (key: string) => values[key], getStored: (key: string) => values[key], set: (key: string, value: any) => { values[key] = structuredClone(value); } };
  const waiting: Array<(value: any) => void> = [];
  const connectionA = { sendAppServerRequest: () => new Promise((resolve) => waiting.push(resolve)) };
  const connectionB = { sendAppServerRequest: async () => ({ version: 1, values: { "local-projects": { b: { id: "b", name: "B", rootPaths: [], createdAt: 0, updatedAt: 0 } }, "thread-project-assignments": {}, "project-order": ["b"], "pinned-project-ids": [], "sidebar-project-thread-orders": {}, "electron-saved-workspace-roots": [], "electron-workspace-root-labels": {}, "project-appearances": {} }, projectIdMap: { b: "native-b" } }) };
  const page: any = { Buffer, __tweakersAccountsDesktopProjectsEnabledV1: () => true, n: { ci: () => "/fallback-home" }, l: { app: { on: (_event: string, listener: () => void) => { onFocus = listener; } } } };
  runInNewContext(nativeAccountsDesktopProjectsSource(), page);
  const projects = page.__twAccountsDesktopProjects;
  const initial = projects.ensureBackend({ cache: { hostId: "local" }, globalState: store, connection: connectionA }, "/connection-home");
  waiting.shift()!({});
  await assert.rejects(initial, /initialization will retry/);
  assert.equal(store.get("local-projects"), undefined, "failed first read is not presented as successful empty data");
  onFocus();
  const staleReply = waiting.shift()!;
  onFocus();
  const newerReply = waiting.shift()!;
  newerReply({ version: 1, values: { "local-projects": { current: { id: "current", name: "Current", rootPaths: [], createdAt: 0, updatedAt: 0 } }, "thread-project-assignments": {}, "project-order": ["current"], "pinned-project-ids": [], "sidebar-project-thread-orders": {}, "electron-saved-workspace-roots": [], "electron-workspace-root-labels": {}, "project-appearances": {} }, projectIdMap: { current: "native-current" } });
  await new Promise((resolve) => setImmediate(resolve));
  staleReply({ version: 1, values: { "local-projects": { stale: { id: "stale", name: "Stale", rootPaths: [], createdAt: 0, updatedAt: 0 } }, "thread-project-assignments": {}, "project-order": ["stale"], "pinned-project-ids": [], "sidebar-project-thread-orders": {}, "electron-saved-workspace-roots": [], "electron-workspace-root-labels": {}, "project-appearances": {} }, projectIdMap: { stale: "native-stale" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(Object.keys(store.get("local-projects")), ["current"]);
  await projects.ensureBackend({ cache: { hostId: "local" }, globalState: store, connection: connectionB }, "/connection-home");
  assert.deepEqual(Object.keys(store.get("local-projects")), ["b"], "a replacement connection refreshes the retained projection");
});

test("actual native queued project writes reverify inside the serialized callback", { skip: !available }, async () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/).map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  const main = patched.sources.get(ACCOUNTS_NATIVE_MAIN_PATH)!;
  const queueStart = main.indexOf("async function DOe(");
  const queueEnd = main.indexOf("var OOe=", queueStart);
  const writeStart = main.indexOf("async runProjectWrite(e,t,n)");
  const writeEnd = main.indexOf("async writeAppServerProject(", writeStart);
  assert.ok(queueStart >= 0 && queueEnd > queueStart && writeStart >= 0 && writeEnd > writeStart);
  const page: any = { __twAccountsDesktopProjects: { ensureWrite: async () => { throw new Error("projection became unverified while queued"); } } };
  runInNewContext(`${main.slice(queueStart, queueEnd)};var __runProjectWrite=({${main.slice(writeStart, writeEnd)}}).runProjectWrite;`, page);
  let release = () => {};
  const prior = new Promise<void>((resolve) => { release = resolve; });
  let rpcCalls = 0;
  const context = { connectionLifetime: { signal: { throwIfAborted: () => {} } }, ensureProjectsReady: async () => {}, pendingProjectWrites: new Map([["project-a", prior]]), projectSupport: "supported" };
  const pending = page.__runProjectWrite.call(context, "project-a", async () => { rpcCalls++; });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await assert.rejects(pending, /projection became unverified while queued/);
  assert.equal(rpcCalls, 0, "a queued write cannot reach the native project RPC after verification becomes stale");
});

test("native Accounts retains fallback behavior when disabled and rejects stale account requests", async () => {
  let enabled = false;
  let accountId = "account_a";
  let generation = 1;
  let finish: (value: unknown) => void = () => {};
  let fallbackCalls = 0;
  const captured: unknown[] = [];
  const page: any = {
    __tweakersAccountsTransportV1: {
      initialize: () => true,
      status: () => ({ compatible: true, enabled }),
      snapshot: () => ({ accountId, generation }),
      subscribe: () => () => {},
      request: (_surface: unknown, _method: unknown, _params: unknown, selection: unknown) => {
        captured.push(selection);
        return new Promise((resolve) => { finish = resolve; });
      },
    },
  };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
  const bridge = page.__tweakersAccountsNativeV1;
  assert.equal(await bridge.request("apps", "app/list", {}, () => { fallbackCalls++; return "native"; }), "native");
  enabled = true;
  const pending = bridge.request("apps", "app/list", {}, () => { fallbackCalls++; return "wrong account"; });
  assert.equal((captured[0] as any).accountId, "account_a");
  accountId = "account_b";
  generation++;
  finish({ data: ["account-a-only"] });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(fallbackCalls, 1, "a scoped request failure must never fall through to a different native account");

  const react = { useState: () => [0, () => {}], useEffect: () => {} };
  const context = { react, jsx: (type: any, props: any) => ({ type, props }) };
  const original = { nativeMenu: true };
  const slot = bridge.render("account-menu", original, context);
  assert.equal(slot.type(slot.props).props["data-tweakers-native-surface"], "account-menu");
  enabled = false;
  assert.equal(slot.type(slot.props), original, "disable restores the exact original native element");
});

test("native query adapters separate account caches and cancel an obsolete query before dispatch", async () => {
  let generation = 1;
  let reads = 0;
  const page: any = {
    __tweakersAccountsTransportV1: {
      initialize: () => true,
      status: () => ({ compatible: true, enabled: true }),
      snapshot: () => ({ accountId: "account_a", generation }),
      subscribe: () => () => {},
    },
  };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
  const react = { useState: () => [0, () => {}], useEffect: () => {} };
  const original = { queryKey: ["apps", "list"], queryHash: "old-native-hash", _defaulted: true, queryFn: async () => { reads++; return "scoped"; } };
  const first = page.__tweakersAccountsNativeV1.query(original, react);
  assert.equal(first.queryHash, undefined);
  assert.equal(first._defaulted, undefined);
  assert.equal(await first.queryFn({}), "scoped");
  generation++;
  const second = page.__tweakersAccountsNativeV1.query(original, react);
  assert.notDeepEqual(first.queryKey, second.queryKey);
  await assert.rejects(first.queryFn({}), { name: "AbortError" });
  assert.equal(reads, 1);
  assert.equal(await second.queryFn({}), "scoped");
  const unrelated = { queryKey: ["conversation", "thread"] };
  assert.equal(page.__tweakersAccountsNativeV1.query(unrelated, react), unrelated);
  let dependencyReads = 0;
  const epoch = page.__tweakersAccountsNativeV1.signalEpoch((initial: number) => ({ initial }));
  const signal = page.__tweakersAccountsNativeV1.signalOptions({ ...original, queryKey: ["plugins", "list"] }, (actual: unknown) => {
    assert.equal(actual, epoch);
    dependencyReads++;
  }, epoch);
  assert.equal(dependencyReads, 1);
  assert.equal(signal.queryHash, undefined);
  generation++;
  await assert.rejects(signal.queryFn({}), { name: "AbortError" });
});

test("native HTTP and configuration flows retain their captured subscription", async () => {
  let accountId = "account_a";
  let generation = 1;
  const calls: any[] = [];
  const page: any = { URL, __tweakersAccountsTransportV1: {
    initialize: () => true,
    status: () => ({ compatible: true, enabled: true }),
    snapshot: () => ({ accountId, generation }),
    subscribe: () => () => {},
    request: async (surface: string, method: string, params: any, selection: any) => {
      calls.push({ surface, method, params, selection });
      return params.path === "/aip/connectors/links/oauth" ? { redirect_url: "https://provider.example/authorize?state=scoped-state" } : { ok: true };
    },
  } };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
  const bridge = page.__tweakersAccountsNativeV1;
  const client = { safePost: () => { throw new Error("wrong native account"); } };
  const queued = bridge.http(client, "safePost");
  accountId = "account_b";
  generation++;
  await assert.rejects(queued("/ps/plugins/{plugin_id}/install", { parameters: { path: { plugin_id: "example" } } }), { name: "AbortError" });
  assert.equal(calls.length, 0);
  await bridge.http(client, "safePost")("/aip/connectors/links/oauth", { requestBody: { connector_id: "example" } });
  const captured = bridge.capture("plugins");
  accountId = "account_c";
  generation++;
  await bridge.http(client, "safePost")("/aip/connectors/links/oauth/callback", { requestBody: { full_redirect_url: "codex://callback?state=scoped-state" } });
  assert.equal(calls[1].selection.accountId, "account_b", "OAuth continuation belongs to the account that started it");
  await assert.rejects(bridge.http(client, "safePost")("/aip/connectors/links/oauth/callback", { requestBody: { full_redirect_url: "codex://callback?state=scoped-state" } }), { name: "AbortError" });
  await assert.rejects(bridge.configRead(captured, () => { throw new Error("wrong fallback"); }), { name: "AbortError" });
  assert.equal(calls.length, 2);
  const original = { queryKey: ["config", "user"], queryFn: () => "native" };
  assert.equal(bridge.configOptions(undefined, original), original, "general config consumers remain native");
  const selected = bridge.configOptions("plugins", original, true);
  assert.equal(selected.meta.tweakersAccountsSurface, "plugins");
  assert.equal((await selected.queryFn()).readSucceeded, true);
  assert.equal(calls[2].surface, "plugins");
  assert.equal(calls[2].method, "config/read");
});

test("native mutation clicks retain their account before callbacks await and suppress obsolete cache writes", async () => {
  for (const surface of ["apps", "plugins", "mcp"]) {
    let generation = 1;
    let release: () => void = () => {};
    let writes = 0;
    const page: any = { __tweakersAccountsTransportV1: {
      initialize: () => true,
      status: () => ({ compatible: true, enabled: true }),
      snapshot: () => ({ accountId: generation === 1 ? "account_a" : "account_b", generation }),
      subscribe: () => () => {},
    } };
    runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
    const bridge = page.__tweakersAccountsNativeV1;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const guarded = bridge.mutation(surface, {
      onMutate: async (variables: unknown) => { await gate; bridge.mutationScope(surface, variables); writes++; },
      mutationFn: () => { writes++; },
      onSuccess: () => { writes++; },
      onError: () => { writes++; },
      onSettled: () => { writes++; },
    });
    let bound: unknown;
    const handle = bridge.mutationHandle(surface, { mutateAsync: async (variables: unknown) => {
      bound = variables;
      await guarded.onMutate(variables);
      return guarded.mutationFn(variables);
    } });
    const pending = handle.mutateAsync({ appId: "a-only-app", pluginId: "a-only-plugin", key: "a-only-server" });
    generation++;
    release();
    await assert.rejects(pending, { name: "AbortError" });
    guarded.onSuccess({}, bound);
    guarded.onError(new Error("obsolete failure"), bound);
    guarded.onSettled({}, null, bound);
    assert.equal(writes, 0, `${surface}: old callbacks cannot write into the newly selected account`);
    const queued = bridge.mutationHandle(surface, { mutateAsync: async (variables: unknown) => {
      generation++;
      return guarded.mutationFn(variables);
    } });
    await assert.rejects(queued.mutateAsync({}), { name: "AbortError" });
    assert.equal(writes, 0, "capture precedes native global onMutate/queue waits too");
  }
});

test("actual native uninstall flows reject a changed account after bundled setup and still release operation locks", { skip: !available }, async () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/).map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  const source = patched.sources.get("webview/assets/app-initial-1b87ae739476.js")!;
  for (const kind of ["direct", "mutation"]) {
    let generation = 1;
    let release = () => {};
    let cleanup = 0;
    let writes = 0;
    let requests = 0;
    let entered = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scope = { get: () => "native-account" };
    const page: any = {
      __tweakersAccountsTransportV1: {
        initialize: () => true, status: () => ({ compatible: true, enabled: true }),
        snapshot: () => ({ accountId: generation === 1 ? "account_a" : "account_b", generation }),
        request: () => { requests++; return {}; },
      },
      aOi: { c: (size: number) => new Array(size) }, jz: () => false,
      Q: {}, EFr: {}, HR: {}, db: () => scope, sb: () => ({}), fb: () => ({}),
      eD: () => () => { writes++; }, Xo: () => ({}), vE: () => false, TU: () => ["apps"],
      fWn: () => "bundled-plugin", mEi: async () => { entered(); await gate; },
      bEi: () => "operation-a", xEi: () => { cleanup++; }, KU: () => { writes++; },
      yb: (options: any) => ({ mutateAsync: async (variables: unknown) => {
        const context = await options.onMutate?.(variables);
        try { const value = await options.mutationFn(variables); await options.onSuccess?.(value, variables, context); return value; }
        catch (error) { await options.onError?.(error, variables, context); throw error; }
        finally { await options.onSettled?.(undefined, null, variables, context); }
      } }),
    };
    runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
    const start = source.indexOf(kind === "direct" ? "async function ZDi(" : "function YDi(");
    const end = source.indexOf(kind === "direct" ? "function QDi(" : "function XDi(", start);
    runInNewContext(source.slice(start, end), page);
    const pending = kind === "direct"
      ? page.ZDi({ scope, hostId: "local", pluginId: "a-only-plugin", queryClient: {} })
      : page.YDi().uninstallPlugin({ pluginId: "a-only-plugin" });
    await started;
    generation++;
    release();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(requests, 0, `${kind}: dispatch must not select the replacement account`);
    assert.equal(writes, 0, `${kind}: stale cache and refresh callbacks must not run`);
    assert.equal(cleanup, 1, `${kind}: operation cleanup survives stale-account rejection`);
  }
});

test("actual native usage redemption captures the click before queued execution and preserves disabled behavior", { skip: !available }, async () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/).map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  const source = patched.sources.get("webview/assets/app-initial-1b87ae739476.js")!;
  let generation = 1;
  let enabled = true;
  let release = () => {};
  let calls = 0;
  let nativeCalls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const page: any = {
    __tweakersAccountsTransportV1: {
      initialize: () => true, status: () => ({ compatible: true, enabled }),
      snapshot: () => ({ accountId: "account_a", generation }),
      request: () => { calls++; return {}; },
    },
    lq: { c: () => [] }, fb: () => ({}), eD: () => () => {},
    vO: { safePost: () => { nativeCalls++; return { code: "nothing_to_reset" }; } },
    yb: (options: any) => ({ mutateAsync: async (variables: unknown) => { await gate; return options.mutationFn(variables); } }),
  };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
  const start = source.indexOf("function w5i(){");
  const end = source.indexOf("function ", source.indexOf("function T5i(", start) + 1);
  runInNewContext(source.slice(start, end), page);
  const handle = page.w5i();
  const pending = handle.mutateAsync({ creditId: "credit-a", redeemRequestId: "request-a" });
  generation++;
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 0);
  assert.equal(nativeCalls, 0);
  enabled = false;
  assert.equal((await page.w5i().mutateAsync({ creditId: "native-credit", redeemRequestId: "native-request" })).code, "nothing_to_reset");
  assert.equal(nativeCalls, 1);
});

test("plugin rollback provenance stays data-only and refuses missing or obsolete install bindings", () => {
  let generation = 1;
  let enabled = true;
  const page: any = { __tweakersAccountsTransportV1: {
    initialize: () => true, status: () => ({ compatible: true, enabled }),
    snapshot: () => ({ accountId: generation === 1 ? "account_a" : "account_b", generation }),
  } };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
  const bridge = page.__tweakersAccountsNativeV1;
  const enrolled = JSON.parse(JSON.stringify(bridge.capture("plugins")));
  assert.equal(bridge.rollbackScope(enrolled).accountId, "account_a");
  assert.throws(() => bridge.rollbackScope(undefined), /original install account could not be verified/);
  generation++;
  assert.throws(() => bridge.rollbackScope(enrolled), { name: "AbortError" });
  assert.throws(() => bridge.rollbackScope(null), /original install account could not be verified/);
  enabled = false;
  assert.equal(bridge.rollbackScope(null), null);
});

test("actual native install handle binds before dispatch and suppresses followups after a stale RPC", { skip: !available }, async () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/).map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  const source = patched.sources.get("webview/assets/app-initial-1b87ae739476.js")!;
  for (const phase of ["queued", "requested"]) {
    let generation = 1;
    let release = () => {};
    let entered = () => {};
    let followups = 0;
    const requests: any[] = [];
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const page: any = {
      __tweakersAccountsTransportV1: {
        initialize: () => true, status: () => ({ compatible: true, enabled: true }),
        snapshot: () => ({ accountId: generation === 1 ? "account_a" : "account_b", generation }),
        request: async (surface: string, method: string, params: unknown, selection: unknown) => {
          requests.push({ surface, method, params, selection }); entered(); await gate; return {};
        },
      },
      performance, d: () => true, Ez: () => ({ pluginName: "example" }), i: {}, t: "local", l: false,
      Kw: { CODEX_PLUGIN_INSTALL_OUTCOME_FAILED: "failed", CODEX_PLUGIN_INSTALL_OUTCOME_SUCCEEDED: "succeeded" },
      gEi: () => { followups++; },
      yb: (options: any) => ({ mutateAsync: async (variables: unknown) => {
        if (phase === "queued") { entered(); await gate; }
        return options.mutationFn(variables);
      } }),
    };
    runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
    const start = source.indexOf("Se=globalThis.__tweakersAccountsNativeV1.mutationHandle");
    const end = source.indexOf(",Ce=be||Se.isPending", start);
    runInNewContext(`var ${source.slice(start, end)};`, page);
    const pending = page.Se.mutateAsync({ installAttemptId: "attempt-a", plugin: { plugin: { name: "example" } }, onRpcSettled: () => {} });
    await started;
    generation++;
    release();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(requests.length, phase === "queued" ? 0 : 1);
    if (requests.length) assert.equal(requests[0].selection.accountId, "account_a");
    assert.equal(followups, 0);
  }
});

test("actual native OAuth rollback enrolls the install account and refuses stale or missing provenance", { skip: !available }, async () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/).map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  const source = patched.sources.get("webview/assets/app-initial-1b87ae739476.js")!;
  let generation = 1;
  let records: any = {};
  let requests = 0;
  const recordKey = {};
  const page: any = {
    __tweakersAccountsTransportV1: {
      initialize: () => true, status: () => ({ compatible: true, enabled: true }),
      snapshot: () => ({ accountId: generation === 1 ? "account_a" : "account_b", generation }),
    },
    H5: recordKey, w2: {}, Lys: new Set(), Mys: 1000, jz: () => false,
    yBr: () => "plugin-a", Oys: () => {}, kys: () => {}, V5: () => true,
    ZDi: () => { requests++; }, FBr: () => {},
  };
  const scope = { get: (key: unknown) => key === recordKey ? records : { kind: "closed" }, set: (_key: unknown, update: any) => { records = update(records); } };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
  const enrollment = source.indexOf("function Cys(");
  runInNewContext(source.slice(enrollment, source.indexOf("async function wys(", enrollment)), page);
  const rollback = source.indexOf("async function jys(");
  runInNewContext(source.slice(rollback, source.indexOf("function V5(", rollback)), page);
  page.Cys(scope, { appId: "app-a", hostId: "local", oauthState: "oauth-a", requestId: "request-a", plugin: { plugin: { id: "plugin-a", name: "example", authPolicy: "ON_INSTALL", installed: false } } });
  const enrolled = JSON.parse(JSON.stringify(records["oauth-a"]));
  assert.equal(enrolled.accountsCapture.accountId, "account_a");
  generation++;
  await assert.rejects(page.jys(scope, enrolled, {}), { name: "AbortError" });
  assert.equal(requests, 0);
  assert.equal(page.Lys.size, 0, "rollback lock is released on a provenance failure");
  delete enrolled.accountsCapture;
  await assert.rejects(page.jys(scope, enrolled, {}), /original install account could not be verified/);
  assert.equal(requests, 0);
  assert.equal(page.Lys.size, 0);
});

test("actual browser followups use captured transport and never the native account helper", { skip: !available }, async () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/).map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  const source = patched.sources.get("webview/assets/app-initial-1b87ae739476.js")!;
  let enabled = true;
  let generation = 1;
  let nativeCalls = 0;
  const calls: any[] = [];
  const page: any = {
    __tweakersAccountsTransportV1: {
      initialize: () => true, status: () => ({ compatible: true, enabled }),
      snapshot: () => ({ accountId: "account_a", generation }),
      request: async (surface: string, method: string, params: unknown, selection: unknown) => { calls.push({ surface, method, params, selection }); return {}; },
    },
    vEi: () => true,
    YX: { chromeNativeHost: { install: () => { nativeCalls++; }, uninstall: () => { nativeCalls++; } } },
  };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
  const start = source.indexOf("async function gEi(");
  const end = source.indexOf("function vEi(", start);
  runInNewContext(source.slice(start, end), page);
  const captured = page.__tweakersAccountsNativeV1.capture("plugins");
  const args = { hostId: "local", marketplacePath: "/fixture/marketplace", marketplaceName: "fixture", pluginName: "browser", accountsCapture: captured };
  await page.gEi(args);
  await page._Ei(args);
  assert.deepEqual(calls.map((call) => call.method), ["browser.install", "browser.uninstall"]);
  assert.equal(calls.every((call) => call.selection.accountId === "account_a"), true);
  assert.equal(nativeCalls, 0);
  generation++;
  await assert.rejects(page._Ei(args), { name: "AbortError" });
  assert.equal(calls.length, 2);
  enabled = false;
  await page.gEi({ ...args, accountsCapture: null });
  assert.equal(nativeCalls, 1);
});

test("actual plugin utility configuration binds every step and stops after an obsolete lookup or write", { skip: !available }, async () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/).map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  const source = patched.sources.get("webview/assets/app-initial-1b87ae739476.js")!;
  for (const phase of ["normal", "lookup", "write", "list", "disabled"]) {
    let generation = 1;
    let installed = false;
    let pluginEnabled = false;
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: Array<{ method: string; selection?: any; native: boolean }> = [];
    const dispatch = async (method: string, _params: unknown, selection?: unknown) => {
      calls.push({ method, selection, native: selection === undefined });
      if (phase === "lookup" && method === "plugin/list" || phase === "write" && method === "config/batchWrite" || phase === "list" && method === "config/read") { entered(); await gate; }
      if (method === "plugin/install") installed = true;
      if (method === "config/batchWrite") pluginEnabled = true;
      if (method === "plugin/list") return { marketplaces: [{ name: "fixture", path: "/fixture/marketplace", plugins: [{ id: "chrome@fixture", name: "chrome", installed, enabled: pluginEnabled }] }] };
      if (method === "config/read") return { config: { plugins: {} } };
      return {};
    };
    const page: any = {
      __tweakersAccountsTransportV1: {
        initialize: () => true, status: () => ({ compatible: true, enabled: phase !== "disabled" }),
        snapshot: () => ({ accountId: generation === 1 ? "account_a" : "account_b", generation }),
        request: (_surface: string, method: string, params: unknown, selection: unknown) => dispatch(method, params, selection),
      },
      Gx: "local", crypto: { randomUUID: () => "utility-install-attempt" },
      Sb: () => ({ sendRequest: (method: string, params: unknown) => dispatch(method, params) }),
      RDi: (_scope: unknown, _host: unknown, params: unknown) => dispatch("plugin/install", params),
      YX: { browserPluginConfig: { syncAfterPluginChange: () => dispatch("browser.sync", {}) }, chromeNativeHost: { install: (params: unknown) => dispatch("browser.install", params) } },
      vEi: () => true, pWn: ({ pluginId, enabled }: any) => [{ keyPath: `plugins.${pluginId}.enabled`, value: enabled }],
      ZC: (value: unknown) => value, fPo: () => [],
    };
    runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
    const listStart = source.indexOf("async function cPo(");
    runInNewContext(source.slice(listStart, source.indexOf("async function lPo(", listStart)), page);
    const configureStart = source.indexOf("async function uPo(");
    runInNewContext(source.slice(configureStart, source.indexOf("function fPo(", configureStart)), page);
    const browserStart = source.indexOf("async function gEi(");
    runInNewContext(source.slice(browserStart, source.indexOf("async function _Ei(", browserStart)), page);
    if (phase === "normal" || phase === "disabled") {
      const listed = await page.cPo({});
      assert.equal(listed.marketplaces[0].name, "fixture");
      assert.equal(listed.configuredPlugins.length, 0);
      assert.deepEqual(calls.map((call) => call.method), ["plugin/list", "config/read"]);
      calls.length = 0;
    }
    const pending = phase === "list" ? page.cPo({}) : page.uPo({}, { marketplaceName: "fixture", pluginName: "chrome", install: true, enabled: true });
    if (phase === "normal" || phase === "disabled") {
      const configured = await pending;
      assert.equal(configured.plugin.installed, true);
      assert.equal(configured.plugin.enabled, true);
      assert.deepEqual(calls.map((call) => call.method), ["plugin/list", "plugin/install", "browser.install", "plugin/list", "config/batchWrite", "plugin/list", "browser.sync"]);
    } else {
      await started;
      generation++;
      release();
      await assert.rejects(pending, { name: "AbortError" });
      assert.deepEqual(calls.map((call) => call.method), phase === "lookup" ? ["plugin/list"] : phase === "list" ? ["plugin/list", "config/read"] : ["plugin/list", "plugin/install", "browser.install", "plugin/list", "config/batchWrite"]);
    }
    assert.equal(calls.every((call) => phase === "disabled" ? call.native : !call.native && call.selection.accountId === "account_a"), true, phase);
  }
});

test("actual native removal preserves validated browser consumers without reinstalling or stopping hosts", { skip: !available }, async () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/).map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  const shared = patched.sources.get(ACCOUNTS_NATIVE_SHARED_PATH)!;
  const root = await fs.mkdtemp(path.join(tmpdir(), "tweakers-browser-consumers-"));
  try {
    for (const scenario of ["survivor", "union", "none", "changed-manifest", "dangling", "escape", "world-writable", "protocol", "malformed", "changed-registry", "native"]) {
      const fixture = path.join(root, scenario);
      const registry = path.join(fixture, "global-registry.json");
      const manifest = path.join(fixture, "manifests", "host.json");
      const consumerA = path.join(fixture, "A");
      const consumerB = path.join(fixture, "B");
      const consumerC = path.join(fixture, "C");
      const consumers: any[] = [];
      for (const [index, home] of [consumerA, consumerB, consumerC].entries()) {
        const plugin = path.join(home, "plugins", "cache", "fixture", "chrome");
        const version = path.join(plugin, "1.0.0");
        await fs.mkdir(version, { recursive: true });
        await fs.writeFile(path.join(version, "host"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        await fs.symlink("1.0.0", path.join(plugin, "latest"));
        consumers.push({ schemaVersion: 2, appServerProtocolVersion: 2, nativeHostProtocolVersion: 2, entryId: `consumer-${index}`,
          nativeHostNames: ["test.native.host"], extensionIds: [`extension-${index}`], paths: { codexHome: home, extensionHostPath: path.join(plugin, "latest", "host") } });
      }
      if (scenario === "dangling") consumers[0].paths.extensionHostPath = path.join(consumerA, "plugins", "cache", "missing");
      if (scenario === "escape") {
        await fs.writeFile(path.join(fixture, "outside-host"), "#!/bin/sh\n", { mode: 0o755 });
        await fs.unlink(path.join(consumerA, "plugins", "cache", "fixture", "chrome", "latest"));
        await fs.symlink(fixture, path.join(consumerA, "plugins", "cache", "fixture", "chrome", "latest"));
        consumers[0].paths.extensionHostPath = path.join(consumerA, "plugins", "cache", "fixture", "chrome", "latest", "outside-host");
      }
      if (scenario === "world-writable") await fs.chmod(path.join(consumerA, "plugins", "cache", "fixture", "chrome", "1.0.0", "host"), 0o757);
      if (scenario === "protocol") consumers[0].nativeHostProtocolVersion = 1;
      const entries = scenario === "none" ? [consumers[1]] : scenario === "union" ? [consumers[1], consumers[2], consumers[0]] : [consumers[1], consumers[0]];
      const registryContents = scenario === "malformed" ? "{broken" : JSON.stringify({ schemaVersion: 2, entries });
      await fs.writeFile(registry, registryContents);
      await fs.mkdir(path.dirname(manifest), { recursive: true });
      await fs.writeFile(manifest, JSON.stringify({ name: "test.native.host", path: consumers[1].paths.extensionHostPath, type: "stdio", allowed_origins: ["chrome-extension://extension-1/"] }));
      const untouchedConfig = path.join(consumerA, "config.toml");
      await fs.writeFile(untouchedConfig, "original consumer config\n");
      let manifestReads = 0;
      let changedRegistry = false;
      let removedRegistration = 0;
      const filesystem = { ...fs,
        readFile: async (file: any, options?: any) => {
          if (file === manifest && ++manifestReads === 2 && scenario === "changed-manifest") {
            await fs.writeFile(manifest, JSON.stringify({ path: "/another/application/host", name: "other.native.host" }));
          }
          return fs.readFile(file, options);
        },
        lstat: async (file: any) => {
          if (scenario === "changed-registry" && !changedRegistry) {
            changedRegistry = true;
            await fs.writeFile(registry, JSON.stringify({ schemaVersion: 2, entries: [consumers[0], consumers[2]] }));
          }
          return fs.lstat(file);
        },
      };
      const page: any = {
        l: { default: filesystem }, i: path, s: { randomUUID }, Buffer, process,
        oX: 2, iX: "chrome-native-hosts-v2.json", lX: "ChatGPT browser native messaging host",
        KX: () => registry, uZ: () => [manifest], iZ: () => "test.native.host", vX: { parse: (value: unknown) => value },
        $Y: { info: () => {} }, MZ: async () => { removedRegistration++; },
        AX: () => { throw new Error("must not reinstall or stop a host"); }, QX: () => { throw new Error("must not rewrite all manifest locations"); },
        // Native UX/IX/mZ execute below; schema adapters supply their reviewed
        // protocol-v2 validation boundary without loading Electron's module.
        TX: { safeParse: (value: any) => ({ success: value?.schemaVersion === 2 && value?.appServerProtocolVersion === 2 && value?.nativeHostProtocolVersion === 2 && Array.isArray(value?.nativeHostNames) && Array.isArray(value?.extensionIds) && typeof value?.paths?.codexHome === "string" && typeof value?.paths?.extensionHostPath === "string", data: value }) },
        EX: { safeParse: (value: any) => ({ success: value?.schemaVersion === 2 && Array.isArray(value?.entries), data: value }) },
        xX: { safeParse: (value: any) => ({ success: typeof value?.path === "string", data: value }) },
        PZ: (error: any, code: string) => error?.code === code,
      };
      // Execute the patched NX and the unchanged native file/registry helpers.
      for (const name of ["NX", "LX", "GX", "IX", "BX", "UX", "jZ", "pZ", "mZ", "tZ", "nZ"]) {
        const functionStart = shared.indexOf(`function ${name}(`);
        const start = shared.slice(functionStart - 6, functionStart) === "async " ? functionStart - 6 : functionStart;
        const next = shared.indexOf("function ", functionStart + 9);
        let end = next;
        if (shared.slice(end - 6, end) === "async ") end -= 6;
        runInNewContext(shared.slice(start, end), page);
      }
      runInNewContext(nativeAccountsConsumerPreservationSource(), page);
      const removal = page.NX({ codexHome: consumerB, marketplaceName: "fixture", pluginName: "chrome", preserveRetainedConsumers: scenario !== "native" });
      if (scenario === "malformed" || scenario === "changed-registry") {
        await assert.rejects(removal, /registry (?:is malformed|changed)/);
        assert.equal(JSON.parse(await fs.readFile(manifest, "utf8")).path, consumers[1].paths.extensionHostPath);
      } else {
        await removal;
        if (scenario === "survivor" || scenario === "union") {
          const retained = JSON.parse(await fs.readFile(manifest, "utf8"));
          assert.equal(retained.path, await fs.realpath(consumers[0].paths.extensionHostPath));
          assert.deepEqual(retained.allowed_origins, scenario === "union" ? ["chrome-extension://extension-0/", "chrome-extension://extension-2/"] : ["chrome-extension://extension-0/"]);
          assert.equal(retained.type, "stdio");
          assert.equal(retained.name, "test.native.host");
          assert.equal(removedRegistration, 0);
        } else if (scenario === "changed-manifest") {
          assert.equal(JSON.parse(await fs.readFile(manifest, "utf8")).path, "/another/application/host");
          assert.equal(removedRegistration, 0);
        } else {
          await assert.rejects(fs.stat(manifest), { code: "ENOENT" });
          assert.equal(removedRegistration, 1);
        }
      }
      if (scenario !== "malformed" && scenario !== "changed-registry") assert.deepEqual(JSON.parse(await fs.readFile(registry, "utf8")).entries, entries.filter((entry) => entry !== consumers[1]), `${scenario}: surviving registry records stay intact`);
      assert.equal(await fs.readFile(untouchedConfig, "utf8"), "original consumer config\n");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

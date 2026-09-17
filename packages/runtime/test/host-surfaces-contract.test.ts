import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createAccountsNativeBridge } from "../src/preload/accounts-native";

const source = readFileSync(resolve(process.cwd(), "packages/runtime/src/preload/host-surfaces.ts"), "utf8");
const host = readFileSync(resolve(process.cwd(), "packages/runtime/src/preload/tweak-host.ts"), "utf8");
const sdk = readFileSync(resolve(process.cwd(), "packages/sdk/src/index.ts"), "utf8");

test("host surfaces expose the approved semantic renderer seam", () => {
  for (const kind of ["projects", "assistant-turns", "composer", "thread-context", "usage", "command-menu", "account-menu", "settings-rows", "apps-settings", "plugins-settings", "mcp-settings", "titlebar-controls"]) {
    assert.match(source, new RegExp(`"${kind}"`));
  }
  assert.match(sdk, /host: HostUiApi/);
  assert.match(host, /host: hostUiApi/);
});

test("all Tweakers share one coalesced mutation observer", () => {
  assert.match(source, /let sharedObserver: MutationObserver \| null = null/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /sharedObserver = new MutationObserver/);
  assert.match(source, /observe\(document\.documentElement, \{[\s\S]*attributeFilter:[\s\S]*characterData: true,[\s\S]*subtree: true/);
  assert.match(source, /function safelyNotify/);
});

test("surface diagnostics and active project context are bounded", () => {
  assert.match(source, /MAX_MATCHES = 100/);
  assert.match(source, /getActiveProject/);
  assert.match(source, /confidence/);
  assert.match(source, /const matches = queryHostSurfaces\(kind\)\.slice\(0, MAX_MATCHES\)/);
});

test("project surfaces fail closed instead of inheriting route context", () => {
  const projectRows = source.slice(source.indexOf("function projectRows"), source.indexOf("function threadContexts"));
  assert.match(projectRows, /directProjectIdentity/);
  assert.match(projectRows, /data-app-action-sidebar-project-id/);
  assert.match(projectRows, /fiberForNode\(element\)[^\n]*memoizedProps/);
  assert.doesNotMatch(projectRows, /getBoundingClientRect/);
  assert.doesNotMatch(projectRows, /fiberProps\(element\)/);
  assert.doesNotMatch(projectRows, /compact\(element\.textContent\) === "Projects"/);
});

test("native account settings surfaces are distinct and never use generic row discovery", () => {
  const nativePages = source.slice(source.indexOf("const NATIVE_SETTINGS_SURFACES"), source.indexOf("export const hostUiApi"));
  assert.match(nativePages, /"apps-settings"/);
  assert.match(nativePages, /"plugins-settings"/);
  assert.match(nativePages, /"mcp-settings"/);

  const nativeDiscovery = source.slice(source.indexOf("function nativeSettingsPageSurface"), source.indexOf("function getActiveProject"));
  assert.match(nativeDiscovery, /\[data-settings-panel-slug\]\[aria-current='page'\]/);
  assert.match(nativeDiscovery, /if \(activeNativeRoutes\.length !== 1\) return \[\]/);
  assert.match(nativeDiscovery, /if \(headings\.length !== 1\) return \[\]/);
  assert.match(nativeDiscovery, /boundedNativeSettingsPageContainer/);
  assert.doesNotMatch(nativeDiscovery, /settings-rows/);
  assert.doesNotMatch(nativeDiscovery, /querySelectorAll\([^\n]*listitem/);
});

test("native account settings discovery observes route changes without changing cleanup ownership", () => {
  const observer = source.slice(source.indexOf("function ensureObserver"), source.indexOf("function safelyNotify"));
  assert.match(observer, /"data-settings-panel-slug"/);
  const cleanup = source.slice(source.indexOf("function observe"), source.indexOf("function ensureObserver"));
  assert.match(cleanup, /sharedObserver\?\.disconnect\(\)/);
  assert.match(cleanup, /pendingFrame = null/);
});

test("shared-history host targets map exact native identities through the reserved preload seam", () => {
  const sharedHistory = source.slice(source.indexOf("export async function getSharedHistoryTarget"), source.indexOf("export function queryHostSurfaces"));
  assert.match(source, /"tweaker:shared-history-map-native-target"/);
  assert.match(sharedHistory, /ipcRenderer\.invoke\(SHARED_HISTORY_MAP_NATIVE_TARGET_CHANNEL/);
  assert.match(sharedHistory, /conversationNativeId/);
  assert.match(sharedHistory, /composerNativeId/);
  assert.match(sharedHistory, /assistantTurnNativeIds/);
  assert.match(sharedHistory, /publicSharedHistoryMapping/);
  assert.match(sharedHistory, /isPublicSharedHistoryConversationId/);
  assert.match(sharedHistory, /isPublicSharedHistoryTurnId/);
  assert.match(sharedHistory, /turnIds\.length !== target\.assistantTurns\.length/);
  assert.match(sharedHistory, /target\.assistantTurns\[index\]\.root/);
  assert.doesNotMatch(sharedHistory, /textContent/);
  assert.doesNotMatch(sharedHistory, /location|href|url/i);
  assert.doesNotMatch(sharedHistory, /sort\(/);
});

test("shared-history SDK result exposes only public handles and exact DOM roots", () => {
  const sharedTypes = sdk.slice(sdk.indexOf("export interface HostSharedHistoryAssistantTurnTarget"), sdk.indexOf("export interface HostMcpFormIdentity"));
  assert.match(sdk, /getSharedHistoryTarget\(\): Promise<HostSharedHistoryTargetResult>/);
  assert.match(sharedTypes, /conversationId: string/);
  assert.match(sharedTypes, /turnId: string/);
  assert.match(sharedTypes, /statusRoot: Element/);
  assert.match(sharedTypes, /composerRoot: Element/);
  assert.match(sharedTypes, /isCurrent\(\): boolean/);
  assert.doesNotMatch(sharedTypes, /native|provider|thread/i);
});

test("Accounts native bridge isolates surface generations and revokes changed compatibility", async () => {
  const hookHash = "a".repeat(64);
  const changedHash = "b".repeat(64);
  const accountOne = `account_${"A".repeat(43)}`;
  const accountTwo = `account_${"B".repeat(43)}`;
  const bridge = createAccountsNativeBridge();
  bridge.api.register({
    async request(surface, method, _params, selection) {
      return { surface, method, accountId: selection.accountId };
    },
  });
  bridge.setCompatibility({ compatible: true, hookSetSha256: hookHash });
  assert.equal(bridge.transport.initialize({ version: 1, hookSetSha256: hookHash }), true);
  bridge.api.select("apps", accountOne);
  bridge.api.select("profile", accountOne);
  const appsSelection = bridge.transport.snapshot("apps");
  bridge.api.select("profile", accountTwo);
  assert.deepEqual(await bridge.transport.request("apps", "app/list", {}, appsSelection), {
    surface: "apps", method: "app/list", accountId: accountOne,
  });

  bridge.setCompatibility({ compatible: false, reason: "receipt unavailable" });
  assert.equal(bridge.api.status().enabled, false);
  bridge.setCompatibility({ compatible: true, hookSetSha256: hookHash });
  assert.equal(bridge.api.status().enabled, true, "the same verified wrapper remains initialized after a fresh check");
  bridge.setCompatibility({ compatible: false, hookSetSha256: changedHash });
  assert.equal(bridge.api.status().enabled, false);
  assert.equal(bridge.api.status().reason, "native-wrapper-changed");
  bridge.setCompatibility({ compatible: true, hookSetSha256: hookHash });
  assert.equal(bridge.api.status().enabled, false, "a changed hook receipt stays revoked until page reload");
  bridge.dispose();
});

test("Accounts native bridge discards a response after that surface changes selection", async () => {
  const hookHash = "c".repeat(64);
  const accountOne = `account_${"C".repeat(43)}`;
  const accountTwo = `account_${"D".repeat(43)}`;
  let release!: () => void;
  const bridge = createAccountsNativeBridge();
  bridge.api.register({
    async request() { await new Promise<void>((resolve) => { release = resolve; }); return { private: "response" }; },
  });
  bridge.setCompatibility({ compatible: true, hookSetSha256: hookHash });
  assert.equal(bridge.transport.initialize({ version: 1, hookSetSha256: hookHash }), true);
  bridge.api.select("mcp", accountOne);
  const pending = bridge.transport.request("mcp", "mcpServerStatus/list", {}, bridge.transport.snapshot("mcp"));
  await Promise.resolve();
  bridge.api.select("mcp", accountTwo);
  release();
  await assert.rejects(pending, /stale-native-selection/);
  bridge.dispose();
});

test("Accounts native bridge binds one OAuth callback to its original account", async (t) => {
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const hookHash = "d".repeat(64);
  const accountA = `account_${"E".repeat(43)}`;
  const accountB = `account_${"F".repeat(43)}`;
  const routed: Array<{ path: unknown; accountId: string | null }> = [];
  const oauthStates = ["state-a", "state-expired", "state-revoked"];
  const bridge = createAccountsNativeBridge();
  bridge.api.register({
    async request(_surface, _method, params, selection) {
      routed.push({ path: params.path, accountId: selection.accountId });
      if (params.path === "/aip/connectors/links/oauth") {
        return { redirect_url: `https://auth.example.test/start?state=${oauthStates.shift()}` };
      }
      return { ok: true };
    },
  });
  bridge.setCompatibility({ compatible: true, hookSetSha256: hookHash });
  assert.equal(bridge.transport.initialize({ version: 1, hookSetSha256: hookHash }), true);

  const begin = async () => {
    bridge.api.select("apps", accountA);
    const captured = bridge.transport.snapshot("apps");
    const result = await bridge.transport.request("apps", "http.request", {
      verb: "POST", path: "/aip/connectors/links/oauth", options: {},
    }, captured) as { redirect_url: string };
    bridge.api.select("apps", accountB);
    return { captured, redirect: result.redirect_url.replace("/start", "/callback") };
  };
  const callback = (captured: { accountId: string | null; generation: number }, fullRedirectUrl: string) => bridge.transport.request(
    "apps", "http.request", {
      verb: "POST",
      path: "/aip/connectors/links/oauth/callback",
      options: { requestBody: { full_redirect_url: fullRedirectUrl } },
    }, captured,
  );

  const first = await begin();
  await callback(first.captured, first.redirect);
  assert.deepEqual(routed.slice(-1)[0], { path: "/aip/connectors/links/oauth/callback", accountId: accountA });
  await assert.rejects(callback(first.captured, first.redirect), /stale-native-selection/, "the state is consumed before dispatch");

  const expired = await begin();
  now += 30 * 60 * 1_000 + 1;
  await assert.rejects(callback(expired.captured, expired.redirect), /stale-native-selection/);

  const revoked = await begin();
  bridge.setCompatibility({ compatible: false, reason: "receipt unavailable" });
  bridge.setCompatibility({ compatible: true, hookSetSha256: hookHash });
  await assert.rejects(callback(revoked.captured, revoked.redirect), /stale-native-selection/);
  bridge.dispose();
});


test("Accounts startup waits for the verified asynchronous renderer wrapper", async () => {
  const bridge = createAccountsNativeBridge();
  const hash = "e".repeat(64);
  bridge.setCompatibility({ compatible: true, hookSetSha256: hash });
  assert.equal(bridge.api.status().reason, "native-wrapper-uninitialized");
  let settled = false;
  const ready = bridge.waitForInitialization(1000).then((status) => { settled = true; return status; });
  await Promise.resolve();
  assert.equal(settled, false, "DOMContentLoaded must not turn a pending wrapper into a failure");
  assert.equal(bridge.transport.initialize({ version: 1, hookSetSha256: hash }), true);
  assert.equal((await ready).compatible, true);
  bridge.dispose();
});

test("Accounts initialization wait preserves rejection, timeout, and teardown", async () => {
  const hash = "e".repeat(64);
  for (const outcome of ["mismatch", "timeout", "dispose", "ownership"] as const) {
    const bridge = createAccountsNativeBridge();
    bridge.setCompatibility({ compatible: true, hookSetSha256: hash });
    const ready = bridge.waitForInitialization(outcome === "timeout" ? 1 : 1000);
    if (outcome === "mismatch") assert.equal(bridge.transport.initialize({ version: 1, hookSetSha256: "f".repeat(64) }), false);
    if (outcome === "dispose") bridge.dispose();
    if (outcome === "ownership") bridge.setCompatibility({ compatible: false, reason: "Accounts is unavailable in this window." });
    const status = await ready;
    assert.equal(status.compatible, false);
    assert.equal(status.reason, outcome === "mismatch" ? "native-wrapper-initialization-rejected"
      : outcome === "timeout" ? "native-wrapper-uninitialized" : outcome === "dispose" ? "disposed"
      : "Accounts is unavailable in this window.");
    bridge.dispose();
  }
});

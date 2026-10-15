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
import { parse } from "acorn";
import { REVIEWED_WORKSPACE_ROUTING_CONTINUITY } from "../src/doctor-protocol";
import { ACCOUNTS_NATIVE_10492_COMPANIONS, ACCOUNTS_NATIVE_10640_COMPANIONS, ACCOUNTS_NATIVE_REQUIRED_HOOKS, validateAccountsNativeCompatibility } from "@therealityreport/tweakers-sdk";
import { nativeBootstrapSource, patchCodexAccountsNativeSources } from "../src/codex-accounts-native";
import { billingAnalyticsPlan, billingAnalyticsRead, patchCodexBillingAnalyticsSource, patchCodexBillingAnalyticsInExtractedApp, patchCodexBillingQueriesSource, usageHistoryState, usageHistoryContext } from "../src/codex-billing-analytics";
import { ACCOUNTS_NATIVE_MAIN_PATH, ACCOUNTS_NATIVE_SHARED_PATH, nativeAccountsConsumerPreservationSource, nativeAccountsDesktopProjectsSource, nativeAccountsMainRegistrationSource } from "../src/codex-accounts-native-main";
import { patchCodexInactiveThreadRetentionSource } from "../src/codex-inactive-thread-retention";
import { patchCodexModelSelectionSource } from "../src/codex-model-selection";
import { patchCodexWindowServicesSource } from "../src/codex-window-services";
import { RendererPatchDeclined } from "../src/renderer-patch-outcome";

// An explicit retained source lets maintenance verify the installed baseline after native Codex updates.
const LIVE_ASAR = process.env.TWEAKERS_TEST_RENDERER_ASAR ?? "/Applications/ChatGPT.app/Contents/Resources/app.asar";
const BILLING_ASAR = process.env.TWEAKERS_TEST_RENDERER_ASAR ?? "/Applications/Tweakers.app/Contents/Resources/app.asar";
const available = existsSync(LIVE_ASAR);
const liveAccountsRecipe = !available ? "unavailable"
  : listPackage(LIVE_ASAR, { isPack: false }).includes("/webview/assets/app-initial-51da50e6c6e3.js") ? "10954"
  : listPackage(LIVE_ASAR, { isPack: false }).includes("/webview/assets/app-initial-e1f6333a805b.js") ? "10640"
  : listPackage(LIVE_ASAR, { isPack: false }).includes("/webview/assets/app-initial-512cdcfeac48.js") ? "10492"
  : listPackage(LIVE_ASAR, { isPack: false }).includes("/webview/assets/app-initial-a498f911edeb.js") ? "9922"
  : listPackage(LIVE_ASAR, { isPack: false }).includes("/webview/assets/app-initial-4d7ea7f81c2d.js") ? "9275"
    : listPackage(LIVE_ASAR, { isPack: false }).includes("/webview/assets/app-initial-9b95fa538c62.js") ? "8881"
    : listPackage(LIVE_ASAR, { isPack: false }).includes("/webview/assets/app-initial-1b87ae739476.js") ? "8378" : "unknown";
const legacyAccountsAvailable = available && liveAccountsRecipe === "8378";

function rendererSources(pattern = /^[/\\]webview[/\\]assets[/\\]app-initial-[^/\\]*\.js$/, asar = LIVE_ASAR): Array<{ path: string; source: string }> {
  return listPackage(asar, { isPack: false })
    .filter((entry) => pattern.test(entry))
    .map((entry) => {
      const relativePath = entry.replace(/^[/\\]/, "");
      return { path: relativePath, source: extractFile(asar, relativePath).toString("utf8") };
    });
}

test("the live renderer still exposes an app-initial bundle", { skip: !available }, () => {
  const sources = rendererSources();
  assert.ok(sources.length > 0, "no app-initial-*.js found in the installed bundle");
});

test("the reviewed Billing Analytics bundle falls back to honest credit-only data and remains idempotent", { skip: !existsSync(BILLING_ASAR) }, async () => {
  const billing = rendererSources(/^[/\\]webview[/\\]assets[/\\]billing-analytics-[^/\\]*\.js$/, BILLING_ASAR);
  assert.equal(billing.length, 1, "expected one Billing Analytics carrier");
  const name = path.basename(billing[0]!.path);
  const patched = patchCodexBillingAnalyticsSource(name, billing[0]!.source);
  assert.ok(["patched", "already-patched"].includes(patched.status));
  assert.equal(patched.changed, patched.status === "patched");
  const latestCarrier = ["billing-analytics-a920e3f98ec7.js", "billing-analytics-e2b01d494bbf.js"].includes(name);
  const newerCarrier = latestCarrier || ["billing-analytics-2f84796974a9.js", "billing-analytics-98d3dcbc947a.js", "billing-analytics-9a493b3c8aaf.js"].includes(name);
  assert.match(patched.source, latestCarrier
    ? /render\?\.\("usage",null,\{jsx:Q\.jsx,react:ia\}\)/ : newerCarrier
    ? /render\?\.\(\"usage\",null,\{jsx:Q\.jsx,react:Fi\}\)/
    : /render\?\.\(\"usage\",null,\{jsx:Q\.jsx,react:vr\}\)/,
    "Analytics must expose the selected Usage account in its native header");
  if (!newerCarrier) {
    const planHistoryHook = patched.source.indexOf("let p=C(),[m,h]=(0,na.useState)(`feature`)");
    const unsupportedPlanHistory = patched.source.indexOf("if(f===`ready`&&d==null)return", planHistoryHook);
    assert.ok(planHistoryHook >= 0 && unsupportedPlanHistory > planHistoryHook,
      "the unsupported plan-history result must not return before the component's hooks run");
  }
  assert.equal(patchCodexBillingAnalyticsSource(name, patched.source).status, "already-patched");
  assert.match(patched.source, /Detailed usage pending/);
  assert.match(patched.source, /Additional credits used/);
  assert.match(patched.source, /other \{Additional credits used\}/);
  assert.match(patched.source, /lifetime plan and additional credit usage/);
  const queryName = name === "billing-analytics-e2b01d494bbf.js" ? "queries-9dd30652911e.js"
    : latestCarrier ? "queries-571c444b922f.js" : name === "billing-analytics-9a493b3c8aaf.js" ? "queries-a53713419c4d.js"
    : name === "billing-analytics-98d3dcbc947a.js" ? "queries-3238bda4c52d.js"
    : newerCarrier ? "queries-6058113866c9.js" : "queries-6246c58ed0c3.js";
  const queries = rendererSources(/^[/\\]webview[/\\]assets[/\\]queries-[^/]+\.js$/, BILLING_ASAR)
    .filter(entry => path.basename(entry.path) === queryName);
  assert.equal(queries.length, 1);
  const patchedQueries = patchCodexBillingQueriesSource(path.basename(queries[0]!.path), queries[0]!.source);
  assert.ok(["patched", "already-patched"].includes(patchedQueries.status));
  assert.match(patchedQueries.source, /kind:\s*"daily-history"/);
  assert.match(patchedQueries.source, /kind:\s*"credit-events"/);
  assert.equal(patchCodexBillingQueriesSource(path.basename(queries[0]!.path), patchedQueries.source).status, "already-patched");
  const querySyntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: patchedQueries.source, encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(querySyntax.status, 0, querySyntax.stderr);
  assert.match(nativeBootstrapSource("reviewed"), /personal-history/);
  assert.match(nativeBootstrapSource("reviewed"), /credit-history/);
  assert.throws(() => patchCodexBillingAnalyticsSource("billing-analytics-ffffffffffff.js", "unreviewed carrier"), /has not been reviewed/);
  if (patched.status === "patched") assert.throws(() => patchCodexBillingAnalyticsSource(name, billing[0]!.source + "\n"), /has not been reviewed/);
  const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: patched.source, encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(syntax.status, 0, syntax.stderr);

});

test("Billing Analytics controlled service fixtures distinguish unsupported, authentication and credit-only results", async () => {
  const calls: string[] = [];
  let discoveries = 0;
  const client = {
    async safePost(endpoint: string) {
      calls.push(endpoint);
      if (endpoint.endsWith("query_v2")) throw Object.assign(new Error("missing"), { status: 404 });
      return { threads: [{ thread_id: "thread-a", estimated_usage_credits_micros: 1_500_000, groups: [] }] };
    },
  };
  const result = await billingAnalyticsRead({
    client,
    roots: [{ id: "thread-a", createdAt: 1 }],
    scope: {},
    chunk: (values: unknown[], size: number) => [values.slice(0, size)],
    signal: new AbortController().signal,
    isTruncated: false,
    discover: async () => { discoveries += 1; return { isComplete: true, descendantThreads: [] }; },
  });
  assert.equal(result.analyticsStatus, "partial");
  assert.equal(result.rows[0].usage.balance_usage_credits, 1.5);
  assert.equal(discoveries, 0, "a missing v2 route must be detected before descendant fan-out");
  assert.deepEqual(calls, ["/wham/usage/thread_usage/query_v2", "/wham/usage/thread_usage/query", "/wham/usage/thread_usage/query"], "v2 is probed exactly once before the selected-account legacy capability is reused");

  const authCalls: string[] = [];
  await assert.rejects(billingAnalyticsRead({
    client: { async safePost(endpoint: string) { authCalls.push(endpoint); throw Object.assign(new Error("signed out"), { status: 401 }); } },
    roots: [{ id: "thread-a", createdAt: 1 }], scope: {}, chunk: (values: unknown[]) => [values],
    signal: new AbortController().signal, isTruncated: false, discover: async () => { throw new Error("must not discover"); },
  }), /signed out/);
  assert.deepEqual(authCalls, ["/wham/usage/thread_usage/query_v2"], "authentication failures never retry through another account or endpoint");

  const unavailable = await billingAnalyticsRead({
    client: { async safePost() { throw Object.assign(new Error("missing"), { status: 404 }); } },
    roots: [{ id: "thread-a", createdAt: 1 }], scope: {}, chunk: (values: unknown[]) => [values],
    signal: new AbortController().signal, isTruncated: false, discover: async () => { throw new Error("must not discover"); },
  });
  assert.equal(unavailable.analyticsStatus, "unsupported");
  assert.equal(await billingAnalyticsPlan({ async safeGet() { throw Object.assign(new Error("missing"), { status: 404 }); } }, new AbortController().signal), null);
});

test("Usage history distinguishes delayed, backfilled, idle, and switched accounts", () => {
  const empty = (date: string) => ({ date, attribution: [] });
  const recorded = (date: string, value: number) => ({ date, attribution: [{ value }] });
  const today = new Date("2026-09-23T05:00:00Z");
  const current = { accountId: "account-a", label: "Account A", remainingPercent: 72, resetAt: "2026-09-29T15:00:00Z" };
  const delayed = usageHistoryState([recorded("2026-09-19", 100), empty("2026-09-22"), empty("2026-09-23")], current, today);
  assert.equal(delayed.account, "Account A");
  assert.equal(delayed.weekly, "Live weekly allowance: 28% used");
  assert.equal(delayed.pending, "Detailed usage pending for 2026-09-22–2026-09-23 UTC");
  assert.equal(delayed.latestRecorded, "2026-09-19");
  assert.equal(usageHistoryState([recorded("2026-09-19", 100), recorded("2026-09-22", 28), empty("2026-09-23")], current, today).pending, null);
  assert.equal(usageHistoryState([empty("2026-09-22"), empty("2026-09-23")], { ...current, remainingPercent: 100 }, today).pending, null);
  const switched = usageHistoryState([recorded("2026-09-22", 49), empty("2026-09-23")],
    { accountId: "account-b", label: "Account B", remainingPercent: 51, resetAt: current.resetAt }, today);
  assert.equal(switched.account, "Account B");
  assert.equal(switched.weekly, "Live weekly allowance: 49% used");
  assert.equal(switched.pending, null);
});

test("the newer native Billing Analytics carrier retains account-scoped history and honest labels", { skip: !available }, async () => {
  const billing = rendererSources(/^[/\\]webview[/\\]assets[/\\]billing-analytics-(?:2f84796974a9|98d3dcbc947a|9a493b3c8aaf)\.js$/);
  const queries = rendererSources(/^[/\\]webview[/\\]assets[/\\]queries-(?:6058113866c9|3238bda4c52d|a53713419c4d)\.js$/);
  if (billing.length === 0 && queries.length === 0) return;
  assert.equal(billing.length, 1);
  assert.equal(queries.length, 1);
  const patchedBilling = patchCodexBillingAnalyticsSource(path.basename(billing[0]!.path), billing[0]!.source);
  const patchedQueries = patchCodexBillingQueriesSource(path.basename(queries[0]!.path), queries[0]!.source);
  assert.equal(patchedBilling.status, "patched");
  assert.equal(patchedQueries.status, "patched");
  assert.match(patchedBilling.source, /Detailed usage pending/);
  assert.match(patchedBilling.source, /other \{Additional credits used\}/);
  assert.match(patchedBilling.source, /lifetime plan and additional credit usage/);
  assert.match(patchedBilling.source, /kind:"thread-usage"/);
  assert.match(patchedBilling.source, /Latest recorded:/);
  assert.match(patchedQueries.source, /kind:\s*"daily-history"/);
  assert.match(patchedQueries.source, /kind:\s*"credit-events"/);
  assert.equal(patchCodexBillingAnalyticsSource(path.basename(billing[0]!.path), patchedBilling.source).status, "already-patched");
  assert.equal(patchCodexBillingQueriesSource(path.basename(queries[0]!.path), patchedQueries.source).status, "already-patched");
  for (const source of [patchedBilling.source, patchedQueries.source]) {
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: source, encoding: "utf8", maxBuffer: 1024 * 1024 });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  const extracted = await fs.mkdtemp(path.join(tmpdir(), "tweakers-billing-reviewed-"));
  try {
    const assets = path.join(extracted, "webview", "assets");
    await fs.mkdir(assets, { recursive: true });
    await fs.writeFile(path.join(assets, path.basename(billing[0]!.path)), billing[0]!.source);
    await fs.writeFile(path.join(assets, path.basename(queries[0]!.path)), queries[0]!.source);
    await fs.writeFile(path.join(assets, "queries-unrelated.js"), "export const unrelated = true;");
    assert.equal(patchCodexBillingAnalyticsInExtractedApp(extracted), true);
    assert.equal(await fs.readFile(path.join(assets, path.basename(billing[0]!.path)), "utf8"), patchedBilling.source);
    assert.equal(await fs.readFile(path.join(assets, path.basename(queries[0]!.path)), "utf8"), patchedQueries.source);
    assert.equal(await fs.readFile(path.join(assets, "queries-unrelated.js"), "utf8"), "export const unrelated = true;");
  } finally {
    await fs.rm(extracted, { recursive: true, force: true });
  }
});

test("the inactive-thread retention policy resolves in the live bundle", { skip: !available }, () => {
  const outcomes = rendererSources(/^[/\\]webview[/\\].*\.[cm]?js$/i).map(({ path, source }) => {
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
  const carrier = rendererSources(/^[/\\]webview[/\\].*\.[cm]?js$/i)
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
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-shared|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread|apps-availability)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/)
    .map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  if (liveAccountsRecipe === "unknown") {
    assert.equal(patched.record.status, "unavailable");
    assert.equal(patched.changed, false);
    assert.deepEqual(patched.sources, sources, "unreviewed live carriers must preserve native bytes");
    return;
  }
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  assert.equal(patched.changed, true);
  assert.equal(patched.record.assets.length, ["10492", "10640", "10954"].includes(liveAccountsRecipe) ? 10 : liveAccountsRecipe === "9922" ? 9 : 8);
  for (const asset of patched.record.assets) {
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: patched.sources.get(asset.path)!, encoding: "utf8", maxBuffer: 1024 * 1024 });
    assert.equal(syntax.status, 0, `${asset.path}: ${syntax.stderr}`);
  }
  const mainPath = patched.record.assets.find(asset => /^\.vite\/build\/main-[^/]+\.js$/.test(asset.path))?.path;
  assert.ok(mainPath, "the selected Accounts recipe must identify its main-process carrier");
  const nativeMain = patched.sources.get(mainPath)!;
  const ensureWrite = nativeMain.indexOf("await __twAccountsDesktopProjects.ensureWrite(this)");
  const firstProjectRpc = nativeMain.indexOf("await t(r)", ensureWrite);
  assert.ok(ensureWrite >= 0, "queued native project writes must verify the current projection inside their serialized callback");
  assert.ok(firstProjectRpc > ensureWrite, "native project writes must verify the current projection before their first RPC");
  const hash = (source: string) => createHash("sha256").update(source).digest("hex");
  assert.equal(validateAccountsNativeCompatibility(patched.record, (path) => patched.sources.get(path)!, hash).compatible, true);
  const again = patchCodexAccountsNativeSources(patched.sources, patched.record);
  assert.equal(again.changed, false);
  assert.deepEqual(again.sources, patched.sources);

  // Exercise the installer's actual patch order as well as pristine native bytes.
  const prepared = new Map(sources);
  const windowServices = patchCodexWindowServicesSource(prepared.get(mainPath)!);
  assert.equal(windowServices?.changed, true);
  prepared.set(mainPath, windowServices!.source);
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
  const primaryPath = patched.record.assets.find(entry => /^webview\/assets\/app-primary-[^/]+\.js$/.test(entry.path))?.path;
  assert.ok(primaryPath, "the selected Accounts recipe must identify its primary renderer carrier");
  duplicate.set("webview/assets/app-primary-ffffffffffff.js", sources.get(primaryPath)!);
  const refused = patchCodexAccountsNativeSources(duplicate);
  assert.equal(refused.record.status, "unavailable");
  assert.equal(refused.changed, false);
  assert.deepEqual(refused.sources, duplicate, "a declined patch must preserve every native byte");
  const drift = new Map(sources);
  drift.set(asset, drift.get(asset)! + "\n");
  assert.equal(patchCodexAccountsNativeSources(drift).record.status, "unavailable");
});

test("reviewed shared-query Accounts builds react to selection changes and keep MCP rendering live", {
  skip: !available || !["10492", "10640"].includes(liveAccountsRecipe),
}, async () => {
  const sources = new Map(rendererSources(/^[/\\](?:webview[/\\]assets[/\\](?:app-initial|app-shared|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread|apps-availability)-[^/\\]*|\.vite[/\\]build[/\\](?:main|src)-[^/\\]*)\.js$/)
    .map(({ path, source }) => [path, source]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  assert.equal(patched.record.build, liveAccountsRecipe === "10492" ? "26.917.51856" : "26.917.61114");
  assert.equal(patched.record.assets.length, 10);
  const hash = (source: string) => createHash("sha256").update(source).digest("hex");
  assert.equal(validateAccountsNativeCompatibility(patched.record, path => patched.sources.get(path)!, hash).compatible, true);
  assert.deepEqual(patchCodexAccountsNativeSources(patched.sources, patched.record).sources, patched.sources);
  const companions = liveAccountsRecipe === "10492" ? ACCOUNTS_NATIVE_10492_COMPANIONS : ACCOUNTS_NATIVE_10640_COMPANIONS;
  for (const companion of Object.keys(companions)) {
    assert.ok(sources.has(companion), `reviewed companion ${companion} is present`);
    const drifted = new Map(patched.sources);
    drifted.set(companion, drifted.get(companion)! + "\n");
    assert.equal(validateAccountsNativeCompatibility(patched.record, path => drifted.get(path)!, hash).compatible, false, companion);
    assert.equal(patchCodexAccountsNativeSources(drifted, patched.record).record.status, "unavailable", companion);
  }
  const extra = new Map(sources);
  extra.set("webview/assets/app-shared-ffffffffffff.js", sources.get(liveAccountsRecipe === "10492"
    ? "webview/assets/app-shared-962598dd111a.js" : "webview/assets/app-shared-6d89d53e1c60.js")!);
  const refused = patchCodexAccountsNativeSources(extra);
  assert.equal(refused.record.status, "unavailable");
  assert.deepEqual(refused.sources, extra, "an unknown shared query carrier leaves every native byte untouched");
  const dataPath = liveAccountsRecipe === "10492" ? "webview/assets/app-initial-512cdcfeac48.js" : "webview/assets/app-initial-e1f6333a805b.js";
  const mcpPath = liveAccountsRecipe === "10492" ? "webview/assets/mcp-settings-bfb9ac8ef6e6.js" : "webview/assets/mcp-settings-30afd02b513b.js";
  const data = patched.sources.get(dataPath)!;
  const mcp = patched.sources.get(mcpPath)!;
  let accountId = "account-a", generation = 1, enabled = true;
  const listeners = new Set<(event: { surface: string | null }) => void>();
  const page: any = {
    __tweakersAccountsTransportV1: {
      initialize: () => true,
      status: () => ({ compatible: true, enabled }),
      snapshot: () => ({ accountId, generation }),
      subscribe: (listener: (event: { surface: string | null }) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
  };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
  const bridge = page.__tweakersAccountsNativeV1;

  // Execute the inserted native ga atom. A selection event refreshes Usage;
  // unrelated events do not, and unmount removes its transport listener.
  const epochStart = data.indexOf("__twAccountsUsageEpoch=ga(X,0,");
  const epochEnd = data.indexOf(",YOn=ga(X,`polling`,", epochStart);
  assert.ok(epochStart >= 0 && epochEnd > epochStart);
  let mounted: ((args: { set: (value: number) => void }) => () => void) | undefined;
  let epochValue = 0;
  const atomPage: any = {
    globalThis: { __tweakersAccountsNativeV1: bridge }, X: {},
    ga: (_scope: unknown, initial: number, onMount: typeof mounted) => { epochValue = initial; mounted = onMount; return {}; },
  };
  runInNewContext(`var __twAccountsUsageEpoch; ${data.slice(epochStart, epochEnd)};`, atomPage);
  assert.ok(mounted);
  const dispose = mounted!({ set: value => { epochValue = value; } });
  for (const listener of listeners) listener({ surface: "apps" });
  assert.equal(epochValue, 0);
  for (const listener of listeners) listener({ surface: "usage" });
  assert.equal(epochValue, 1);
  dispose();
  assert.equal(listeners.size, 0);

  const pollingStart = data.indexOf("XOn=as(X,({get:e})=>{e(__twAccountsUsageEpoch);");
  const pollingEnd = data.indexOf(",n=e(Czt)", pollingStart);
  assert.ok(pollingStart >= 0 && pollingEnd > pollingStart);
  const pollingPage: any = {
    globalThis: { __tweakersAccountsNativeV1: bridge }, X: {}, YOn: {}, Czt: {},
    __twAccountsUsageEpoch: {}, as: (_scope: unknown, read: unknown) => read,
  };
  runInNewContext(`var ${data.slice(pollingStart, pollingEnd)};return t;});returnValue=XOn({get:e=>e===YOn?"native-sse":0});`, pollingPage);
  assert.equal(pollingPage.returnValue, "polling", "pooled Accounts keep polling their selected usage");
  enabled = false;
  runInNewContext(`returnValue=XOn({get:e=>e===YOn?"native-sse":0});`, pollingPage);
  assert.equal(pollingPage.returnValue, "native-sse", "native ownership restores the SSE setting");
  enabled = true;

  // A scoped query cannot read the next account's cached value or commit a
  // result that finished after the account changed.
  const react: any = { useState: () => [0, () => {}], useEffect: () => {} };
  let resolveRead = (_value: string) => {};
  const read = new Promise<string>(resolve => { resolveRead = resolve; });
  const options = { queryKey: ["config", "mcp", "servers"], queryFn: () => read };
  const first = bridge.query(options, react);
  assert.deepEqual(Array.from(first.queryKey).slice(-3, -1), ["tweakers-accounts", "account-a"]);
  const pending = first.queryFn({});
  accountId = "account-b"; generation++;
  const second = bridge.query(options, react);
  assert.deepEqual(Array.from(second.queryKey).slice(-3, -1), ["tweakers-accounts", "account-b"]);
  resolveRead("old account's MCP config");
  await assert.rejects(pending, { name: "AbortError" });
  enabled = false;
  assert.equal(bridge.query(options, react), options, "native MCP queries use their original cache and transport");
  enabled = true;

  // Execute the inserted MCP child in its React context. It must produce a
  // mountable slot, update on MCP events, and restore the original child.
  const renderStart = mcp.indexOf('globalThis.__tweakersAccountsNativeV1.render("mcp"');
  const renderEnd = mcp.indexOf(",(0,p.jsx)(u,{manageOnly:!0})", renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  let rerenders = 0, cleanup = () => {};
  const mcpReact = {
    useState: () => [0, () => { rerenders++; }],
    useEffect: (effect: () => () => void) => { cleanup = effect(); },
  };
  const jsx = (type: any, props: any) => ({ type, props });
  const renderPage: any = { globalThis: { __tweakersAccountsNativeV1: bridge }, p: { jsx }, __twAccountsReact: () => mcpReact };
  const slot = runInNewContext(mcp.slice(renderStart, renderEnd), renderPage);
  assert.equal(typeof slot.type, "function");
  const content = slot.type(slot.props);
  assert.equal(content.props["data-tweakers-native-surface"], "mcp");
  for (const listener of listeners) listener({ surface: "usage" });
  assert.equal(rerenders, 0);
  for (const listener of listeners) listener({ surface: "mcp" });
  assert.equal(rerenders, 1);
  cleanup();
  assert.equal(listeners.size, 0);
  enabled = false;
  assert.equal(slot.type(slot.props), null);
});

test("build 8378 native browser helpers receive the selected account home through the actual native sync functions", { skip: !legacyAccountsAvailable }, async () => {
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
    { version: 1, access: "read_write", source: "app_server", authorityGeneration: 1, values: { "local-projects": { "legacy-a": { id: "legacy-a", name: "A", rootPaths: ["/a"], createdAt: 0, updatedAt: 0 } }, "thread-project-assignments": { "thread-a": { projectKind: "local", projectId: "legacy-a" } }, "project-order": ["legacy-a"], "pinned-project-ids": [], "sidebar-project-thread-orders": { "legacy-a": { threadIds: ["thread-a"] } }, "electron-saved-workspace-roots": ["/a"], "electron-workspace-root-labels": { "/a": "A" }, "project-appearances": {} }, projectIdMap: { "legacy-a": "native-a" } },
    new Error("temporary read failure"),
    { version: 1, access: "read_write", source: "app_server", authorityGeneration: 1, values: { "local-projects": { "legacy-a": { id: "legacy-a", name: "A from server", rootPaths: ["/a"], createdAt: 0, updatedAt: 0 }, "native-c": { id: "native-c", name: "C", rootPaths: ["/c"], createdAt: 0, updatedAt: 0 } }, "thread-project-assignments": {}, "project-order": ["legacy-a", "native-c"], "pinned-project-ids": [], "sidebar-project-thread-orders": {}, "electron-saved-workspace-roots": ["/a", "/c"], "electron-workspace-root-labels": {}, "project-appearances": {} }, projectIdMap: { "legacy-a": "native-a", "native-c": "native-c" } },
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
  const connectionB = { sendAppServerRequest: async () => ({ version: 1, access: "read_write", source: "app_server", authorityGeneration: 1, values: { "local-projects": { b: { id: "b", name: "B", rootPaths: [], createdAt: 0, updatedAt: 0 } }, "thread-project-assignments": {}, "project-order": ["b"], "pinned-project-ids": [], "sidebar-project-thread-orders": {}, "electron-saved-workspace-roots": [], "electron-workspace-root-labels": {}, "project-appearances": {} }, projectIdMap: { b: "native-b" } }) };
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
  newerReply({ version: 1, access: "read_write", source: "app_server", authorityGeneration: 1, values: { "local-projects": { current: { id: "current", name: "Current", rootPaths: [], createdAt: 0, updatedAt: 0 } }, "thread-project-assignments": {}, "project-order": ["current"], "pinned-project-ids": [], "sidebar-project-thread-orders": {}, "electron-saved-workspace-roots": [], "electron-workspace-root-labels": {}, "project-appearances": {} }, projectIdMap: { current: "native-current" } });
  await new Promise((resolve) => setImmediate(resolve));
  staleReply({ version: 1, access: "read_write", source: "app_server", authorityGeneration: 1, values: { "local-projects": { stale: { id: "stale", name: "Stale", rootPaths: [], createdAt: 0, updatedAt: 0 } }, "thread-project-assignments": {}, "project-order": ["stale"], "pinned-project-ids": [], "sidebar-project-thread-orders": {}, "electron-saved-workspace-roots": [], "electron-workspace-root-labels": {}, "project-appearances": {} }, projectIdMap: { stale: "native-stale" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(Object.keys(store.get("local-projects")), ["current"]);
  await projects.ensureBackend({ cache: { hostId: "local" }, globalState: store, connection: connectionB }, "/connection-home");
  assert.deepEqual(Object.keys(store.get("local-projects")), ["b"], "a replacement connection refreshes the retained projection");
});

test("saved desktop projects seed memory without writes and reinitialize on identical-data authority transitions", async () => {
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const values: Record<string, any> = {
    "app-server-pending-project-deletions-by-host": { "local:/bound": { pending: true } },
    "tweakers-accounts-project-overrides-v1": { version: 1, fields: {} },
  };
  const before = createHash("sha256").update(JSON.stringify(values)).digest("hex");
  const writes: string[] = [], notifications: any[] = [];
  const store = { get: (key: string) => values[key], getStored: (key: string) => values[key], set: (key: string, value: any) => { writes.push(key); values[key] = plain(value); } };
  const projection: any = { version: 1, access: "read_only", source: "saved_local", authorityGeneration: 1,
    values: { "local-projects": { legacy: { id: "legacy", name: "Tweakers", rootPaths: ["/Users/thomashulihan/Projects/tweakers"], createdAt: 0, updatedAt: 0 } },
      "thread-project-assignments": { thread: { projectKind: "local", projectId: "legacy" } }, "project-order": ["legacy"], "pinned-project-ids": ["legacy"],
      "sidebar-project-thread-orders": {}, "electron-saved-workspace-roots": ["/Users/thomashulihan/Projects/tweakers"], "electron-workspace-root-labels": {}, "project-appearances": {} }, projectIdMap: { legacy: "native" } };
  let internalNotification: (message: any) => void = () => {}, syncs = 0, stopped = 0;
  const connection = { codexHome: async () => "/bound", sendAppServerRequest: async () => plain(projection),
    registerInternalNotificationHandler: (fn: (message: any) => void) => { internalNotification = fn; return () => {}; } };
  const page: any = { Buffer, __tweakersAccountsDesktopProjectsEnabledV1: () => true, n: { ci: () => { throw Error("must not infer home"); } }, l: { app: { on: () => {} } } };
  runInNewContext(nativeAccountsDesktopProjectsSource(), page);
  const projects = page.__twAccountsDesktopProjects;
  const backend: any = { cache: { hostId: "local" }, globalState: store, connection, connected: false, disposed: false,
    pendingDeletions: { stop: () => { stopped++; } }, legacyProjectIdsByServerId: new Map(), serverProjectsByLegacyId: new Map(), startConnectionSync: () => { syncs++; } };
  assert.equal(await projects.ensureBackend(backend, "/bound"), true);
  await projects.ensure({ globalState: store, windowManager: { sendMessageToAllWindows: (message: any) => notifications.push(message) } });
  assert.equal(backend.projectsReady, true);
  assert.equal(backend.migrationIdentity, null);
  assert.equal(backend.legacyProjectIdsByServerId.get("native"), "legacy");
  assert.equal(store.get("thread-project-assignments").thread.projectId, "legacy");
  for (const key of ["local-projects", "thread-project-assignments", "project-order", "pinned-project-ids", "project-appearances", "app-server-projects-migration-by-host", "app-server-pending-project-deletions-by-host", "projectless-thread-ids", "tweakers-accounts-project-overrides-v1"]) {
    assert.throws(() => store.set(key, {}), /read-only/);
  }
  await assert.rejects(projects.ensureWrite(backend), /read-only/);
  assert.deepEqual(writes, []);
  assert.equal(createHash("sha256").update(JSON.stringify(values)).digest("hex"), before, "saved initialization, reads and rejected writes preserve fixture state");
  projection.source = "app_server";
  internalNotification({ method: "tweakers/desktopProjects/changed" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await projects.ensureBackend(backend, "/bound"), true, "readable child data without current write authority remains read-only");
  assert.equal(backend.projectsReady, true);
  assert.equal(store.get("thread-project-assignments").thread.projectId, "legacy");
  await assert.rejects(projects.ensureWrite(backend), /read-only/);
  assert.equal(createHash("sha256").update(JSON.stringify(values)).digest("hex"), before);
  backend.connected = true;
  let finishMigration!: () => void;
  backend.threadMigration = new Promise<void>(resolve => { finishMigration = resolve; });
  projection.access = "read_write"; projection.source = "app_server"; projection.authorityGeneration = 2;
  internalNotification({ method: "tweakers/desktopProjects/changed" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(backend.projectsReady, false, "same project values still invalidate native initialization");
  assert.equal(syncs, 0, "recovery waits for the existing migration to settle");
  backend.threadMigration = null; finishMigration();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(syncs, 1, "recovery immediately retries native initialization without a focus event");
  assert.ok(notifications.some(message => message.type === "global-state-updated"));
  await projects.ensureWrite(backend);
  projection.access = "read_only"; projection.source = "saved_local"; projection.authorityGeneration = 3;
  internalNotification({ method: "tweakers/desktopProjects/changed" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(syncs, 2);
  assert.equal(backend.migrationIdentity, null);
  await assert.rejects(projects.ensureWrite(backend), /read-only/);
  assert.ok(stopped >= 3);
  assert.deepEqual(writes, []);
});

test("build 8378 actual native queued project writes reverify inside the serialized callback", { skip: !legacyAccountsAvailable }, async () => {
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

test("shared plugin catalog and mutations use native services without account availability", async () => {
  let generation = 1;
  let nativeCalls = 0;
  const page: any = { __tweakersAccountsTransportV1: {
    initialize: () => true, status: () => ({ compatible: true, enabled: true }),
    snapshot: () => ({ accountId: null, generation }),
    request: () => { throw new Error("account_unavailable"); },
  } };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
  const bridge = page.__tweakersAccountsNativeV1;
  const fallback = () => { nativeCalls++; return { native: true }; };
  const captured = bridge.capture("plugins");
  assert.equal(captured, undefined);
  const options = { queryKey: ["plugins", "list"], queryFn: fallback };
  assert.equal(bridge.options(options), options);
  assert.equal(bridge.configOptions("plugins", options), options);
  assert.equal(bridge.scopedQuery(options, captured), options);
  assert.equal(bridge.filter(options), options);
  assert.equal(bridge.render("plugins", options, {}), options);
  assert.equal(bridge.key("plugins"), "native");
  const mutation = { mutationFn: fallback, onSuccess: fallback };
  assert.equal(bridge.mutation("plugins", mutation), mutation);
  const finalized: string[] = [];
  const cleanup = bridge.mutation("plugins", {
    meta: { accountsFinalize: () => finalized.push("unlock") },
    onSettled: () => finalized.push("native-settled"),
  });
  cleanup.onSettled(undefined, new Error("native failure"), {}, {});
  assert.deepEqual(finalized, ["unlock", "native-settled"]);
  const handle = { mutateAsync: fallback };
  assert.equal(bridge.mutationHandle("plugins", handle), handle);
  const client = { safeGet: fallback, safePost: fallback };
  const queued = bridge.http(client, "safeGet", captured);
  generation++;
  assert.equal(bridge.isCurrent(captured), true);
  assert.doesNotThrow(() => bridge.ensure(captured));
  assert.equal(bridge.rollbackScope(captured), undefined);
  assert.equal(bridge.mutationScope("plugins", {}), undefined);
  await queued("/ps/plugins/installed");
  await bridge.http(client, "safePost", captured)("/apps/content");
  await bridge.http(client, "safePost", captured)("/aip/connectors/links/list_accessible");
  await bridge.http(client, "safePost", captured)("/ps/plugins/{plugin_id}/enable");
  await bridge.rpc("plugin/list", {}, fallback);
  await bridge.rpc("config/batchWrite", { edits: [{keyPath: "plugins.example.enabled"}] }, fallback);
  await bridge.configRead(captured, fallback);
  await bridge.capturedRpc(captured, "plugin/install", {}, fallback);
  assert.equal(nativeCalls, 8);
  // Other subscription-bound surfaces still fail closed.
  await assert.rejects(bridge.rpc("app/list", {}, fallback), /account_unavailable/);
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
  const signal = page.__tweakersAccountsNativeV1.signalOptions({ ...original, queryKey: ["apps", "list"] }, (actual: unknown) => {
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
  await assert.rejects(queued("/aip/connectors/links/noauth", { requestBody: { connector_id: "example" } }), { name: "AbortError" });
  assert.equal(calls.length, 0);
  await bridge.http(client, "safePost")("/aip/connectors/links/oauth", { requestBody: { connector_id: "example" } });
  const captured = bridge.capture("apps");
  accountId = "account_c";
  generation++;
  await bridge.http(client, "safePost")("/aip/connectors/links/oauth/callback", { requestBody: { full_redirect_url: "codex://callback?state=scoped-state" } });
  assert.equal(calls[1].selection.accountId, "account_b", "OAuth continuation belongs to the account that started it");
  await assert.rejects(bridge.http(client, "safePost")("/aip/connectors/links/oauth/callback", { requestBody: { full_redirect_url: "codex://callback?state=scoped-state" } }), { name: "AbortError" });
  await assert.rejects(bridge.configRead(captured, () => { throw new Error("wrong fallback"); }), { name: "AbortError" });
  assert.equal(calls.length, 2);
  const original = { queryKey: ["config", "user"], queryFn: () => "native" };
  assert.equal(bridge.configOptions(undefined, original), original, "general config consumers remain native");
  const selected = bridge.configOptions("apps", original, true);
  assert.equal(selected.meta.tweakersAccountsSurface, "apps");
  assert.equal((await selected.queryFn()).readSucceeded, true);
  assert.equal(calls[2].surface, "apps");
  assert.equal(calls[2].method, "config/read");
});

test("native mutation clicks retain their account before callbacks await and suppress obsolete cache writes", async () => {
  for (const surface of ["apps", "mcp"]) {
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

test("build 8378 actual native uninstall flows reach native dispatch across pool changes and release locks on native failure", { skip: !legacyAccountsAvailable }, async () => {
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
    let nativeCalls = 0;
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
      zDi: () => { nativeCalls++; throw new Error("native uninstall fixture"); }, qU: () => Promise.resolve(), XDi: () => {},
      aOi: { c: (size: number) => new Array(size) }, jz: () => false,
      Q: {}, EFr: {}, HR: {}, db: () => scope, sb: () => ({}), fb: () => ({}),
      eD: () => () => { writes++; }, Xo: () => ({}), vE: () => false, TU: () => ["apps"],
      fWn: () => "bundled-plugin", mEi: async () => { entered(); await gate; },
      bEi: () => "operation-a", xEi: () => { cleanup++; }, KU: () => { writes++; },
      yb: (options: any) => ({ mutateAsync: async (variables: unknown) => {
        const context = await options.onMutate?.(variables);
        let failure: unknown = null;
        try { const value = await options.mutationFn(variables); await options.onSuccess?.(value, variables, context); return value; }
        catch (error) { failure = error; throw error; }
        finally { await options.onSettled?.(undefined, failure, variables, context); }
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
    await assert.rejects(pending, /native uninstall fixture/);
    assert.equal(nativeCalls, 1);
    assert.equal(requests, 0, `${kind}: dispatch must not select the replacement account`);
    assert.equal(writes, 0, `${kind}: failed native dispatch must not update cache`);
    assert.equal(cleanup, 1, `${kind}: operation cleanup survives native rejection`);
  }
});

test("build 8378 actual native usage redemption captures the click before queued execution and preserves disabled behavior", { skip: !legacyAccountsAvailable }, async () => {
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

test("scoped rollback provenance rejects obsolete captures while native plugin ownership stays unscoped", () => {
  let generation = 1;
  let enabled = true;
  const page: any = { __tweakersAccountsTransportV1: {
    initialize: () => true, status: () => ({ compatible: true, enabled }),
    snapshot: () => ({ accountId: generation === 1 ? "account_a" : "account_b", generation }),
  } };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
  const bridge = page.__tweakersAccountsNativeV1;
  const enrolled = JSON.parse(JSON.stringify(bridge.capture("apps")));
  assert.equal(bridge.rollbackScope(enrolled).accountId, "account_a");
  assert.equal(bridge.rollbackScope(bridge.capture("plugins")), undefined);
  generation++;
  assert.throws(() => bridge.rollbackScope(enrolled), { name: "AbortError" });
  assert.throws(() => bridge.rollbackScope(null), /original install account could not be verified/);
  enabled = false;
  assert.equal(bridge.rollbackScope(null), null);
});

test("build 8378 actual native install handle preserves shared native ownership across pool changes", { skip: !legacyAccountsAvailable }, async () => {
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
      RDi: async () => { requests.push({ native: true }); if (phase === "requested") { entered(); await gate; } return {}; },
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
    await pending;
    assert.deepEqual(requests, [{ native: true }]);
    assert.equal(followups, 1);
  }
});

test("build 8378 actual native OAuth rollback preserves shared native plugin ownership", { skip: !legacyAccountsAvailable }, async () => {
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
  assert.equal(enrolled.accountsCapture, undefined);
  generation++;
  await page.jys(scope, enrolled, {});
  assert.equal(requests, 1);
  assert.equal(page.Lys.size, 0, "rollback lock is released on a provenance failure");
  delete enrolled.accountsCapture;
  await page.jys(scope, enrolled, {});
  assert.equal(requests, 2);
  assert.equal(page.Lys.size, 0);
});

test("build 8378 actual browser followups use native shared plugin helpers", { skip: !legacyAccountsAvailable }, async () => {
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
  assert.equal(calls.length, 0);
  assert.equal(nativeCalls, 2);
  generation++;
  await page._Ei(args);
  assert.equal(calls.length, 0);
  assert.equal(nativeCalls, 3);
  enabled = false;
  await page.gEi({ ...args, accountsCapture: null });
  assert.equal(nativeCalls, 4);
});

test("build 8378 actual plugin utility configuration keeps native plugin operations independent of pooled selection", { skip: !legacyAccountsAvailable }, async () => {
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
      await pending;
      assert.deepEqual(calls.map((call) => call.method), phase === "list" ? ["plugin/list", "config/read"] : ["plugin/list", "plugin/install", "browser.install", "plugin/list", "config/batchWrite", "plugin/list", "browser.sync"]);
    }
    assert.equal(calls.every((call) => call.native), true, phase);
  }
});

test("build 8378 actual native removal preserves validated browser consumers without reinstalling or stopping hosts", { skip: !legacyAccountsAvailable }, async () => {
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

// Supply a frozen signed candidate explicitly; the installed app is not a moving
// fixture for a new build's acceptance. Existing 8378 checks remain independent.
test("reviewed Accounts recipe preserves native behavior and rejects stale account operations", {
  skip: !available || !["8881", "9275", "9922"].includes(liveAccountsRecipe),
}, async () => {
  const asar = process.env.TWEAKERS_TEST_ACCOUNTS_CANDIDATE_ASAR ?? LIVE_ASAR;
  const sources = new Map(listPackage(asar, { isPack: false })
    .filter((entry) => /^\/(?:webview\/assets\/(?:app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread|apps-availability|plugin-installation-content)-|\.vite\/build\/(?:main|src)-).*\.js$/.test(entry))
    .map((entry) => [entry.slice(1), extractFile(asar, entry.slice(1)).toString("utf8")]));
  const patched = patchCodexAccountsNativeSources(sources);
  assert.equal(patched.record.status, "compatible", patched.record.reason);
  assert.equal(patched.record.build, liveAccountsRecipe === "9922" ? "26.915.31945" : liveAccountsRecipe === "9275" ? "26.908.70816" : "26.908.40834");
  assert.equal(patched.record.assets.length, liveAccountsRecipe === "9922" ? 9 : 8);
  assert.deepEqual(patched.record.hooks, [...ACCOUNTS_NATIVE_REQUIRED_HOOKS]);
  const hash = (source: string) => createHash("sha256").update(source).digest("hex");
  assert.equal(validateAccountsNativeCompatibility(patched.record, p => patched.sources.get(p)!, hash).compatible, true);
  assert.deepEqual(patchCodexAccountsNativeSources(patched.sources, patched.record).sources, patched.sources);
  for (const asset of patched.record.assets) {
    const drift = new Map(sources);
    drift.set(asset.path, drift.get(asset.path)! + "\n");
    const refused = patchCodexAccountsNativeSources(drift);
    assert.equal(refused.changed, false, asset.path);
    assert.equal(refused.record.status, "unavailable", asset.path);
    assert.deepEqual(refused.sources, drift);
    const missing = new Map(sources);
    missing.delete(asset.path);
    assert.equal(patchCodexAccountsNativeSources(missing).record.status, "unavailable", asset.path);
  }
  const duplicate = new Map(sources);
  const primaryPath = liveAccountsRecipe === "9922" ? "webview/assets/app-primary-426732871368.js" : liveAccountsRecipe === "9275"
    ? "webview/assets/app-primary-4af6ed7f68d1.js"
    : "webview/assets/app-primary-44ec287874b7.js";
  duplicate.set("webview/assets/app-primary-ffffffffffff.js", sources.get(primaryPath)!);
  assert.equal(patchCodexAccountsNativeSources(duplicate).record.status, "unavailable");
  const composed = new Map(sources);
  for (const [p, text] of composed) {
    if (p === ".vite/build/main-DaMR-wdT.js" || p === ".vite/build/main-DUHZj4_w.js") composed.set(p, patchCodexWindowServicesSource(text)!.source);
    if (p.startsWith("webview/")) {
      const model = patchCodexModelSelectionSource(text)?.source ?? text;
      composed.set(p, patchCodexInactiveThreadRetentionSource(model)?.source ?? model);
    }
  }
  const installed = patchCodexAccountsNativeSources(composed);
  assert.equal(installed.record.status, "compatible", installed.record.reason);
  for (const asset of installed.record.assets) {
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], {
      input: installed.sources.get(asset.path)!, encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    assert.equal(syntax.status, 0, `${asset.path}: ${syntax.stderr}`);
  }
  const initialPath = liveAccountsRecipe === "9922" ? "webview/assets/app-initial-a498f911edeb.js" : liveAccountsRecipe === "9275"
    ? "webview/assets/app-initial-4d7ea7f81c2d.js"
    : "webview/assets/app-initial-9b95fa538c62.js";
  const source = patched.sources.get(initialPath)!;
  if (liveAccountsRecipe === "9922") {
    const appsPath = "webview/assets/apps-availability-d00c1dea79ce.js";
    const sharedPluginPath = "webview/assets/plugin-installation-content-d6156c457f49.js";
    assert.equal(patched.sources.get(sharedPluginPath), sources.get(sharedPluginPath));
    assert.ok(!patched.record.assets.some(asset => asset.path === sharedPluginPath));
    assert.equal(validateAccountsNativeCompatibility({ ...patched.record, assets: patched.record.assets.filter(asset => asset.path !== appsPath) }, p => patched.sources.get(p)!, hash).compatible, false);
    assert.equal(validateAccountsNativeCompatibility({ ...patched.record, build: "26.908.70816" }, p => patched.sources.get(p)!, hash).compatible, false);
    const extraApps = new Map(sources);
    extraApps.set("webview/assets/apps-availability-ffffffffffff.js", sources.get(appsPath)!);
    assert.equal(patchCodexAccountsNativeSources(extraApps).record.status, "unavailable");
    for (const path of ["webview/assets/app-initial-ffffffffffff.js", "webview/assets/app-primary-ffffffffffff.js", "webview/assets/apps-availability-ffffffffffff.js", "webview/assets/app-initial-unknown.js", "webview/assets/app-primary-unknown.js", "webview/assets/apps-availability-unknown.js", "webview/assets/profile-unknown.js", "webview/assets/plugins-page-unknown.js", "webview/assets/mcp-settings-unknown.js", "webview/assets/local-conversation-thread-unknown.js", "webview/assets/local-conversation-thread-ffffffffffff.js", ".vite/build/main-unknown.js", ".vite/build/src-unknown.js"]) {
      for (const [baseline, receipt] of [[sources, undefined], [patched.sources, patched.record]] as const) {
        const unknown = new Map(baseline);
        unknown.set(path, "export const unknownCarrier=true;");
        const refused = patchCodexAccountsNativeSources(unknown, receipt);
        assert.equal(refused.record.status, "unavailable", path);
        assert.equal(refused.changed, false, path);
        assert.deepEqual(refused.sources, unknown, path);
      }
    }
    for (const companion of ["webview/assets/local-conversation-thread-f8327c905ea9.js", "webview/assets/local-conversation-thread-turn-entries-cfb6c7641138.js", "webview/assets/plugins-page-section-fd67748f7b50.js", "webview/assets/profile-lock-bbe1ace3e7b9.js", "webview/assets/profile-page-35bcbb29571e.js", "webview/assets/profile-settings-877920a2e831.js", "webview/assets/profile-settings-a8f55d5c9f38.js", "webview/assets/profile-state-6eb6ff226ae8.js", "webview/assets/profile-state-9f803fee788a.js", ".vite/build/src-BSoROW9v.js", ".vite/build/src-C9YLnbgY.js"]) {
      assert.ok(sources.has(companion), "pristine build includes " + companion);
      assert.equal(patched.sources.get(companion), sources.get(companion));
      assert.ok(!patched.record.assets.some(asset => asset.path === companion));
      const drifted = new Map(patched.sources);
      drifted.set(companion, drifted.get(companion)! + "\n");
      assert.equal(patchCodexAccountsNativeSources(drifted, patched.record).record.status, "unavailable");
      assert.equal(validateAccountsNativeCompatibility(patched.record, p => drifted.get(p)!, hash).compatible, false, "startup must reject changed " + companion);
      const missing = new Map(sources);
      missing.delete(companion);
      assert.equal(patchCodexAccountsNativeSources(missing).record.status, "unavailable", "preparation must reject missing " + companion);
    }
    const apps = patched.sources.get(appsPath)!;
    const appsFunction = apps.slice(apps.indexOf("function I(e){"), apps.indexOf("var R,z,B;"));
    const configRead = source.slice(source.indexOf("async function qun("), source.indexOf("function Jun("));
    for (const phase of ["queued", "read", "write", "unchanged"]) {
      let generation = 1, nativeCalls = 0, successCalls = 0;
      let release = () => {}, entered = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const requests: any[] = [];
      const queryClient = {
        cancelQueries: async () => { if (phase === "queued") { entered(); await gate; } },
        getQueryData: () => [], setQueryData: () => {},
      };
      const page: any = {
        __tweakersAccountsTransportV1: {
          initialize: () => true, status: () => ({ compatible: true, enabled: true }),
          snapshot: () => ({ accountId: generation === 1 ? "account_a" : "account_b", generation }),
          request: async (surface: string, method: string, params: unknown, selection: unknown) => {
            requests.push({ surface, method, params, selection });
            if ((phase === "read" && method === "config/read") || (phase === "write" && method === "config/batchWrite")) { entered(); await gate; }
            return method === "config/read" ? { layers: [{ filePath: "/account-a/config.toml", expectedVersion: "a" }] } : { status: "ok" };
          },
        },
        performance, R: { c: () => Array(36).fill(Symbol.for("react.memo_cache_sentinel")) },
        T: () => ({ get: () => ({ success: () => { successCalls++; }, danger: () => { throw new Error("stale error callback"); } }) }),
        s: {}, g: () => null, S: {}, O: () => queryClient, k: () => async () => {},
        a: () => ({ formatMessage: () => "enabled" }), j: () => ["apps", "local"], A: () => false,
        F: () => [], h: [], E: [], w: [], c: {}, z: "apps", B: {}, t: { error: () => {} },
        Jun: (layers: any[]) => layers[0], bb: () => { nativeCalls++; throw new Error("native config read"); },
        _: () => ({ sendRequest: () => { nativeCalls++; throw new Error("native config write"); } }),
        p: (options: any) => ({ isPending: false, mutateAsync: async (variables: unknown) => {
          const context = await options.onMutate?.(variables);
          const result = await options.mutationFn(variables);
          await options.onSuccess?.(result, variables, context);
          await options.onSettled?.(result, null, variables, context);
          return result;
        } }),
      };
      runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
      runInNewContext(configRead + ";var d=qun;" + appsFunction, page);
      const pending = page.I().setAppEnabled({ appId: "app-a", enabled: true });
      if (phase !== "unchanged") { await started; generation++; release(); await assert.rejects(pending, { name: "AbortError" }); }
      else await pending;
      assert.equal(nativeCalls, 0, phase);
      assert.equal(successCalls, phase === "unchanged" ? 1 : 0, phase);
      assert.deepEqual(requests.map(call => call.method), phase === "queued" ? [] : phase === "read" ? ["config/read"] : ["config/read", "config/batchWrite"], phase);
      for (const call of requests) assert.equal(call.selection.accountId, "account_a", phase);
    }
    // The actual patched low-level RPC preserves native shared Plugin work.
    let generation = 1, routed = 0, release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const page: any = { __tweakersAccountsTransportV1: {
      initialize: () => true, status: () => ({ compatible: true, enabled: true }),
      snapshot: () => ({ accountId: "account", generation }), request: () => { routed++; },
    }, performance, Den: 1 };
    runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
    const rpcStart = source.indexOf("async sendRequest(e,t,n){if(this.dispatchMessage==null)");
    const rpcEnd = source.indexOf("async sendAppServerExtensionRequest", rpcStart);
    const rpc = runInNewContext(`({${source.slice(rpcStart, rpcEnd)}})`, page);
    rpc.dispatchMessage = true;
    rpc.enqueueRequest = async () => { await gate; return "native installed"; };
    const pending = rpc.sendRequest("plugin/install", {});
    generation++; release();
    assert.equal(await pending, "native installed");
    assert.equal(routed, 0);
    // Execute the 9922 profile, Usage and credit adapters, including their native fallback.
    let selectedGeneration = 1, enabled = true, releaseRead = () => {}, readStarted = () => {};
    let deferredMethod: string | null = null;
    let readGate = Promise.resolve();
    const scopedCalls: any[] = [], nativeCalls: any[] = [];
    let creditCacheWrites = 0;
    const adapterPage: any = {
      __tweakersAccountsTransportV1: {
        initialize: () => true, status: () => ({ compatible: true, enabled }),
        snapshot: () => ({ accountId: "account_a", generation: selectedGeneration }),
        request: async (surface: string, method: string, params: any, selection: any) => {
          scopedCalls.push({ surface, method, params, selection });
          if (method === deferredMethod) { readStarted(); await readGate; }
          if (method === "profile.statistics") return { stats: { lifetime_tokens: 7 }, profile: { display_name: " Selected " }, metadata: {} };
          if (method === "usage.credits.consume") return { code: "reset", credit: { id: "credit-a" } };
          if (method === "config/read") return { config: { mcp_servers: {} }, layers: [] };
          return { selected: true };
        },
      },
      performance, oy: {
        safeGet: async (path: string, options: unknown) => { nativeCalls.push({ path, options }); return {}; },
        safePost: async (path: string, options: unknown) => { nativeCalls.push({ path, options }); return {}; },
      },
      aYi: () => [], q$s: () => null, Qv: "CODEX", Iv: class extends Error {},
      OIa: { safeParse: () => ({ success: false }) }, NIa: { safeParse: () => ({ success: false }) },
      AIa: { safeParse: () => ({ success: false }) }, MIa: { safeParse: () => ({ success: false }) }, wIa: { parse: () => null },
      VR: { c: () => Array(3).fill(Symbol.for("react.memo_cache_sentinel")) },
      Kf: () => ({ setQueryData: () => { creditCacheWrites++; } }), Dv: () => async () => {},
      Zf: (options: any) => ({ mutateAsync: async (variables: unknown) => {
        const result = await options.mutationFn(variables);
        await options.onSuccess?.(result, variables);
        return result;
      } }),
    };
    runInNewContext(nativeBootstrapSource("a".repeat(64)), adapterPage);
    runInNewContext(source.slice(source.indexOf("async function B$s("), source.indexOf("async function V$s(")), adapterPage);
    runInNewContext(source.slice(source.indexOf("async function EIa("), source.indexOf("var DIa,")), adapterPage);
    runInNewContext(source.slice(source.indexOf("function gSi("), source.indexOf("function ySi(")), adapterPage);
    const profile = await adapterPage.B$s();
    assert.equal(profile.displayName, "Selected");
    assert.equal(profile.summary.totalTextTokens, 7);
    assert.equal(nativeCalls.length, 0);
    const signal = new AbortController().signal;
    const usage = await adapterPage.EIa({ additionalHeaders: { "X-Example": "preserved" }, signal });
    assert.equal(usage.selected, true);
    assert.equal(nativeCalls[0].options.signal, signal);
    assert.equal(nativeCalls[0].options.additionalHeaders["X-Example"], "preserved");
    assert.equal(nativeCalls[0].options.additionalHeaders["OAI-App-Brand"], "codex");
    assert.equal((await adapterPage.gSi()).selected, true);
    await adapterPage._Si().mutateAsync({ creditId: "credit-a", redeemRequestId: "request-a" });
    assert.equal(creditCacheWrites, 1);
    for (const method of ["profile.statistics", "usage.status", "usage.credits.read", "usage.credits.consume"]) {
      deferredMethod = method;
      readGate = new Promise<void>(resolve => { releaseRead = resolve; });
      const started = new Promise<void>(resolve => { readStarted = resolve; });
      const operation = method === "profile.statistics" ? adapterPage.B$s() : method === "usage.status" ? adapterPage.EIa({ signal }) : method === "usage.credits.read" ? adapterPage.gSi() : adapterPage._Si().mutateAsync({ creditId: "credit-a", redeemRequestId: "stale-request" });
      await started; selectedGeneration++; releaseRead();
      await assert.rejects(operation, { name: "AbortError" });
    }
    assert.equal(creditCacheWrites, 1, "stale reset completion must not update the credit cache");
    deferredMethod = null;
    enabled = false;
    await adapterPage.gSi();
    await adapterPage._Si().mutateAsync({ creditId: "native", redeemRequestId: "native" });
    assert.ok(nativeCalls.some(call => call.path === "/wham/rate-limit-reset-credits"));
    assert.ok(nativeCalls.some(call => call.path === "/wham/rate-limit-reset-credits/consume"));
    enabled = true;
    // The actual MCP query consumer receives the scoped config and cache key.
    Object.assign(adapterPage, {
      xb: { c: () => Array(12).fill(Symbol.for("react.memo_cache_sentinel")) }, xf: () => ({}), $: {},
      vf: () => false, cb: {}, sb: {}, Qun: ["config", "mcp", "servers"], kv: { FIVE_MINUTES: 300000 },
      Nun: () => { throw new Error("native MCP configuration read"); }, Aun: (value: unknown) => value,
      Jf: (options: any) => adapterPage.__tweakersAccountsNativeV1.options(options),
    });
    runInNewContext(source.slice(source.indexOf("function kun("), source.indexOf("function Aun(")), adapterPage);
    const mcp = adapterPage.kun(null, { accountsNativeSurface: "mcp", useActiveWorkspaceRoot: false });
    assert.equal(mcp.queryKey.at(-3), "tweakers-accounts");
    assert.equal(mcp.queryKey.at(-2), "account_a");
    assert.ok((await mcp.queryFn({})).config.mcp_servers);
    selectedGeneration++;
    await assert.rejects(mcp.queryFn({}), { name: "AbortError" });
    assert.ok(scopedCalls.some(call => call.surface === "mcp" && call.method === "config/read"));
    // Execute the inserted stale OAuth cleanup against its actual 9922 bindings.
    const callbackStart = source.indexOf("if(O=!0,!globalThis.__tweakersAccountsNativeV1.oauthResultCurrent(e))");
    const callbackEnd = source.indexOf("if(C())", callbackStart);
    assert.ok(callbackStart >= 0 && callbackEnd > callbackStart);
    const cleared: any[] = [];
    const callbackPage: any = {
      globalThis: { __tweakersAccountsNativeV1: { oauthResultCurrent: () => false } },
      O: false, S: "old-state", x: "old-state", E: "old-state", Vul: new Set(["old-state", "new-state"]),
      n: {}, _: {}, e: { link: { connector_id: "app-a", name: "App A" } },
      f9: (_scope: unknown, state: string) => cleared.push(state), o: (value: any) => cleared.push(value),
    };
    assert.equal(runInNewContext(`(function(){${source.slice(callbackStart, callbackEnd)}})()`, callbackPage).kind, "success");
    assert.equal(callbackPage.Vul.has("old-state"), false);
    assert.equal(callbackPage.Vul.has("new-state"), true);
    assert.equal(cleared[0], "old-state");
    assert.equal(cleared[1].oauthState, "old-state");
    // Run the injected main registration with the real selected-home sync/selection functions.
    const main = patched.sources.get(".vite/build/main-DUHZj4_w.js")!;
    const homes: string[] = [], mainCalls: string[] = [];
    const mainPage: any = {
      n: { Ai: () => false, yi: () => { throw new Error("wrong native home"); }, Dl: () => "openai-bundled", Al: "cua_repl",
        Jt: async (options: any) => homes.push(options.codexHome), Xt: async (options: any) => { assert.equal(options.preserveRetainedConsumers, true); homes.push(options.codexHome); } },
      a: { en: { resolve: () => "/app" } }, Cr: () => ({ browserUseTinysky: true }), Co: () => {}, Oi: {},
      ui: () => ({ platform: "darwin" }), Hi: () => false, Ui: () => ({ serviceAppPath: null }), Lre: () => false,
      Ho: async () => ({}), Sne: async (options: any) => { homes.push(options.codexHome); return false; },
      Pre: async (options: any) => { homes.push(options.codexHome); }, Ki: () => "/resources", Iie: () => [], Wi: { "mcp_servers.cua_repl": null },
      __twAccountsDesktopProjects: { refresh: () => {} }, l: { app: { getVersion: () => "26.915.31945", isPackaged: true } }, process: { resourcesPath: "/resources" },
    };
    runInNewContext(main.slice(main.indexOf("async function So("), main.indexOf("function Co(")) + main.slice(main.indexOf("async function Fie("), main.indexOf("function Iie(")) + ";var Pie=class{constructor(options){this.options=options}syncAfterPluginChange(){return Fie(this.options)}};" + main.slice(main.lastIndexOf(';((__name)=>{Object.defineProperty(globalThis,"__tweakersAccountsNativeMainV1"')), mainPage);
    const nativeBridge = mainPage.__tweakersAccountsNativeMainV1.create({ codexHome: "/selected/account-a", appServerVersion: "0.153.4", assertCurrent: () => {}, request: async (method: string) => { mainCalls.push(method); return method === "plugin/list" ? { marketplaces: [] } : { status: "ok" }; } });
    await nativeBridge.sync();
    await nativeBridge.install({ hostId: "local", marketplacePath: "/marketplace", pluginName: "chrome" });
    await nativeBridge.uninstall({ hostId: "local", marketplaceName: "openai-bundled", pluginName: "chrome" });
    assert.deepEqual(homes, Array(4).fill("/selected/account-a"));
    assert.deepEqual(mainCalls, ["plugin/list", "config/batchWrite"]);
    return;
  }
  // Shared Plugins keep native install ownership across pool selection changes.
  for (const phase of ["queued", "requested"]) {
    let generation = 1, followups = 0;
    let release = () => {}, entered = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const requests: any[] = [];
    const page: any = {
      __tweakersAccountsTransportV1: {
        initialize: () => true, status: () => ({ compatible: true, enabled: true }),
        snapshot: () => ({ accountId: generation === 1 ? "account_a" : "account_b", generation }),
        request: async (surface: string, method: string, params: unknown, selection: unknown) => {
          requests.push({ surface, method, params, selection }); entered(); await gate; return {};
        },
      },
      performance, f: () => true, Y9o: () => false, mO: () => ({ pluginName: "example" }), i: {}, t: "local", u: false,
      Iy: { CODEX_PLUGIN_INSTALL_OUTCOME_FAILED: "failed", CODEX_PLUGIN_INSTALL_OUTCOME_SUCCEEDED: "succeeded" },
      S1r: async () => { requests.push({ native: true }); if (phase === "requested") { entered(); await gate; } return {}; },
      e$r: () => { followups++; },
      wm: (options: any) => ({ mutateAsync: async (variables: unknown) => {
        if (phase === "queued") { entered(); await gate; }
        return options.mutationFn(variables);
      } }),
    };
    runInNewContext(nativeBootstrapSource("a".repeat(64)), page);
    const start = source.indexOf("be=globalThis.__tweakersAccountsNativeV1.mutationHandle");
    const end = source.indexOf(",xe=ve||be.isPending", start);
    assert.ok(start >= 0 && end > start);
    runInNewContext(`var ${source.slice(start, end)};`, page);
    const pending = page.be.mutateAsync({ installAttemptId: "attempt-a", plugin: { plugin: { name: "example" } }, onRpcSettled: () => {} });
    await started;
    generation++;
    release();
    await pending;
    assert.deepEqual(requests, [{ native: true }]);
    assert.equal(followups, 1);
  }
  // A stale OAuth completion clears its original state, never the ownership
  // boolean or a later account's pending connection.
  const callbackStart = source.indexOf("if(k=!0,!globalThis.__tweakersAccountsNativeV1.oauthResultCurrent(e))");
  const callbackEnd = source.indexOf("if(w())", callbackStart);
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart);
  const cleared: unknown[] = [];
  const callbackPage: any = {
    globalThis: { __tweakersAccountsNativeV1: { oauthResultCurrent: () => false } },
    k: false, T: true, D: "old-oauth-state", S: "old-oauth-state",
    R8: new Set(["old-oauth-state", "other-oauth-state"]),
    e: { link: { connector_id: "app-a", name: "App A" } }, _: {},
    l: (state: string) => cleared.push(state), o: (value: unknown) => cleared.push(value),
  };
  const callback = runInNewContext(`(function(){${source.slice(callbackStart, callbackEnd)}})()`, callbackPage);
  assert.equal(callback.kind, "success");
  assert.equal(callbackPage.R8.has("old-oauth-state"), false);
  assert.equal(callbackPage.R8.has("other-oauth-state"), true);
  assert.equal(cleared[0], "old-oauth-state");
  assert.equal((cleared[1] as any).oauthState, "old-oauth-state");
  // The new usage request must preserve its header options and cancellation.
  let observed: any;
  const usagePage: any = {
    DS: { safeGet: async (_path: string, options: unknown) => { observed = options; return {}; } },
    SS: "CODEX", zCa: { safeParse: () => ({ success: false }) }, WCa: { safeParse: () => ({ success: false }) },
    VCa: { safeParse: () => ({ success: false }) }, UCa: { safeParse: () => ({ success: false }) },
  };
  runInNewContext(nativeBootstrapSource("a".repeat(64)), usagePage);
  const usageStart = source.indexOf("async function LCa(");
  const usageEnd = source.indexOf("var RCa,", usageStart);
  runInNewContext(source.slice(usageStart, usageEnd).replace(/async $/, ""), usagePage);
  const signal = new AbortController().signal;
  await usagePage.LCa({ additionalHeaders: { "X-Example": "preserved" }, signal });
  assert.equal(observed.signal, signal);
  assert.equal(observed.additionalHeaders["X-Example"], "preserved");
  assert.equal(observed.additionalHeaders["OAI-App-Brand"], "codex");
});


test("reviewed native workspace routing preserves discovery, account guards, and invalidation", {
  skip: !process.env.TWEAKERS_TEST_WORKSPACE_ROUTING_BEFORE_ASAR || !process.env.TWEAKERS_TEST_WORKSPACE_ROUTING_AFTER_ASAR,
}, async () => {
  const pins = REVIEWED_WORKSPACE_ROUTING_CONTINUITY;
  const specs = [
    {asar: process.env.TWEAKERS_TEST_WORKSPACE_ROUTING_BEFORE_ASAR!, hash: pins.beforeAsar, file: ".vite/build/src-C3YaUE83.js",
      names: ["zv", "Uv", "Hv", "Bv", "Vv", "IN", "RN", "RB", "zB", "BB", "VB", "HB"],
      aliases: {CC: "awaitSignal", SC: "deferred", Lp: "unknownSchema"}},
    {asar: process.env.TWEAKERS_TEST_WORKSPACE_ROUTING_AFTER_ASAR!, hash: pins.afterAsar, file: ".vite/build/src-mOb8On4V.js",
      names: ["Pv", "Rv", "Lv", "Fv", "Iv", "NN", "FN", "rV", "iV", "aV", "oV", "sV"],
      aliases: {fC: "awaitSignal", dC: "deferred", Ip: "unknownSchema"}},
  ];
  const programs: string[] = [];
  for (const spec of specs) {
    assert.equal(`sha256:${createHash("sha256").update(await fs.readFile(spec.asar)).digest("hex")}`, spec.hash);
    const source = extractFile(spec.asar, spec.file).toString("utf8");
    const ast = parse(source, {ecmaVersion: "latest", sourceType: "module"});
    const declarations = new Map<string, string>();
    const walk = (node: any): void => {
      if (!node || typeof node !== "object") return;
      if (node.type === "FunctionDeclaration" && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") declarations.set(node.id.name, `const ${source.slice(node.start, node.end)};`);
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") walk(value);
    };
    walk(ast);
    const renames = new Map<string, string>([...spec.names.map((name, i) => [name, `native${i}`] as [string, string]), ...Object.entries(spec.aliases)]);
    const program = spec.names.map(name => {assert.ok(declarations.has(name), name); return declarations.get(name)!;}).join("\n");
    programs.push(program.replace(/\b[A-Za-z_$][\w$]*\b/g, name => renames.get(name) ?? name));
  }
  // This comparison includes the shipped schemas, JWT decoder and semver logic,
  // not just the routing class. Vendor bytes stay outside the repository.
  assert.equal(programs[0], programs[1]);

  // Only the schema-library primitives and async adapter are test dependencies.
  // The native schema declarations and all routing/decoder/version logic execute
  // directly from each pinned ASAR. This is not an authenticated account test.
  type Issue = {path: string[]};
  type Schema = {read: (value: any, path: string[]) => any; optional: () => Schema; nullable: () => Schema;
    min: (n: number) => Schema; refine: (predicate: (value: any) => boolean) => Schema;
    safeParse: (value: any) => any};
  const schema = (read: Schema["read"]): Schema => ({read,
    optional: () => schema((v, p) => v === undefined ? v : read(v, p)),
    nullable: () => schema((v, p) => v === null ? v : read(v, p)),
    min: n => schema((v, p) => {const result = read(v, p); if (result.length < n) throw {path: p}; return result;}),
    refine: predicate => schema((v, p) => {const result = read(v, p); if (!predicate(result)) throw {path: p}; return result;}),
    safeParse: value => {try {return {success: true, data: read(value, [])};} catch (issue) {return {success: false, error: {issues: [issue as Issue]}};}},
  });
  const primitive = (type: string) => schema((v, p) => {if (typeof v !== type) throw {path: p}; return v;});
  const bindings = {Buffer, URL, AbortController, DOMException,
    U: () => primitive("string"), G: () => primitive("boolean"), unknownSchema: () => schema(v => v),
    J: (values: string[]) => schema((v, p) => {if (!values.includes(v)) throw {path: p}; return v;}),
    q: (shape: Record<string, Schema>) => schema((v, p) => {
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw {path: p};
      return Object.fromEntries(Object.entries(shape).map(([key, child]) => [key, child.read(v[key], [...p, key])]));
    }),
    awaitSignal: async (promise: Promise<unknown>, signal: AbortSignal) => {signal.throwIfAborted(); return await promise;},
    deferred: () => {let resolve!: (value?: unknown) => void; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};},
  };
  const token = (claim: unknown = false, accountId = "account-a") => `x.${Buffer.from(JSON.stringify({"https://api.openai.com/auth": {
    chatgpt_account_id: accountId, chatgpt_account_is_fedramp: claim,
  }})).toString("base64url")}.x`;
  const unavailable = "Workspace routing is unavailable for this account and app-server version";
  const workspace = {chatgptAccountId: "account-a", backendOrigin: "https://example.com", accountRoutingOverride: "NO_CONSTRAINT"};
  const cases: Array<{name: string; version?: string | null; account?: any; requirements?: any; token?: string | null; expected: string}> = [
    {name: "legacy", expected: "legacy"},
    {name: "minimum", version: "0.141.0", expected: "legacy"},
    {name: "below minimum", version: "0.140.9", expected: unavailable},
    {name: "last prerelease", version: "0.155.0-alpha.4", expected: "legacy"},
    {name: "cutoff", version: "0.155.0-alpha.5", expected: unavailable},
    {name: "new backend", version: "0.155.0-alpha.16", expected: unavailable},
    {name: "invalid version", version: "bad", expected: unavailable},
    {name: "missing version", version: null, expected: unavailable},
    {name: "explicit null", account: {account: {type: "chatgpt"}, workspaceRouting: null}, expected: unavailable},
    {name: "workspace", account: {account: {type: "chatgpt"}, workspaceRouting: workspace}, expected: "workspace"},
    {name: "wrong principal", account: {account: {type: "chatgpt"}, workspaceRouting: workspace}, token: token(false, "account-b"), expected: "Workspace routing does not match the authenticated account"},
    {name: "base URL", requirements: {chatgptBaseUrl: "https://example.com"}, expected: unavailable},
    {name: "residency", requirements: {enforceResidency: "us"}, expected: unavailable},
    {name: "network", requirements: {application: {network: false}}, expected: unavailable},
    {name: "fedramp", token: token(true), expected: unavailable},
    {name: "malformed claim", token: token("yes"), expected: "Invalid ChatGPT FedRAMP account claim"},
    {name: "no token", token: null, expected: "null"},
    {name: "api key", account: {account: {type: "apiKey"}}, expected: "null"},
    {name: "no account", account: {account: null}, expected: "null"},
    {name: "malformed response", account: {account: 3}, expected: "Invalid workspace routing discovery response"},
    {name: "malformed requirements", requirements: {chatgptBaseUrl: 3}, expected: "Invalid workspace routing discovery response"},
  ];
  const allResults: string[][] = [];
  for (const program of programs) {
    const Routing = runInNewContext(`${program}\nnative11`, {...bindings});
    const results: string[] = [];
    for (const scenario of cases) {
      let requests = 0;
      const routing = new Routing({appServerVersion: scenario.version === undefined ? "0.153.4" : scenario.version,
        getAuthToken: async () => scenario.token === undefined ? token() : scenario.token,
        sendAppServerExtensionRequest: async (method: string) => {requests++; return method === "account/read"
          ? scenario.account ?? {account: {type: "chatgpt"}} : {requirements: scenario.requirements ?? null};},
      }, () => {});
      let result: string;
      try {result = (await routing.get(false))?.routing.kind ?? "null";} catch (error) {result = (error as Error).message;}
      assert.equal(result, scenario.expected, scenario.name);
      results.push(result);
      if (scenario.name === "legacy") {
        const first = await routing.get(false);
        assert.equal(requests, 2, "unchanged discovery is cached");
        routing.invalidate();
        assert.equal(first.signal.aborted, true);
        assert.equal((await routing.get(false)).routing.kind, "legacy");
        assert.equal(requests, 4, "invalidation repeats discovery");
      }
      if (scenario.token === null) assert.equal(requests, 0);
      routing.reset();
    }
    allResults.push(results);
  }
  assert.deepEqual(allResults[0], allResults[1]);
});


test("Billing Analytics cancellation releases pending discovery and disabled Accounts hides its context", { timeout: 3000 }, async () => {
  const controller = new AbortController();
  let discoveryStarted!: () => void;
  const started = new Promise<void>(resolve => { discoveryStarted = resolve; });
  const pending = billingAnalyticsRead({
    client: { safePost: async () => ({ threads: [] }) },
    roots: [{ id: "cancelled-root", createdAt: 1 }], scope: "test", signal: controller.signal,
    chunk: (items: unknown[]) => [items], isTruncated: false,
    discover: () => { discoveryStarted(); return new Promise(() => {}); },
  });
  await started;
  controller.abort(new Error("cancelled discovery"));
  await assert.rejects(pending, /cancelled discovery/);
  assert.equal(usageHistoryContext({ buckets: [],
    react: { useState: () => [0, () => {}], useEffect: () => {} },
    jsx: () => { throw new Error("Disabled Accounts must not render an unavailable account"); },
  }), null);
});

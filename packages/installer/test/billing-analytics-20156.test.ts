import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { extractFile, listPackage } from "@electron/asar";
import { parse } from "acorn";
import { patchCodexBillingAnalyticsSource, patchCodexBillingQueriesSource } from "../src/codex-billing-analytics";

const asar = process.env.TWEAKERS_TEST_20156_ASAR ?? join(process.env.HOME ?? "", "Library/Application Support/Tweakers/official-source/baselines/0ba76dd5-6b9a-4bc1-b4c1-7c867e02e4d6/resources/app.asar");
const name = "billing-analytics-a920e3f98ec7.js", queryName = "queries-571c444b922f.js";
const available = existsSync(asar) && listPackage(asar, { isPack: false }).includes(`/webview/assets/${name}`);
const source = (): string => extractFile(asar, `webview/assets/${name}`).toString("utf8");
function functionSource(patched: string, name: string): string {
  const ast = parse(patched, { ecmaVersion: "latest", sourceType: "module" });
  const node = ast.body.find(node => node.type === "FunctionDeclaration" && node.id?.name === name);
  assert.ok(node, `missing ${name}`);
  return patched.slice(node.start, node.end);
}
const jsx = (type: unknown, props: any): any => ({ type, props });
function runtime(cache: unknown[]): Record<string, any> {
  return { ra: { c: () => cache }, ia: { useState: (value: unknown) => [value, () => {}], useId: () => "id" },
    Q: { jsx, jsxs: jsx }, _t: Object.assign(() => {}, { Header: "header", Content: "content" }),
    J: "text", Ee: "panel", $i: "table", u: "button", ft: "empty",
    Hi: ["five_hour_limit_percent", "weekly_limit_percent", "balance_usage_credits"], ta: () => null };
}

test("20156 billing and query carriers patch together, parse, and reject changed vendor bytes", { skip: !available }, () => {
  const original = source(), patched = patchCodexBillingAnalyticsSource(name, original);
  assert.equal(patched.status, "patched");
  parse(patched.source, { ecmaVersion: "latest", sourceType: "module" });
  assert.equal(patchCodexBillingAnalyticsSource(name, patched.source).status, "already-patched");
  assert.throws(() => patchCodexBillingAnalyticsSource(name, original + "\n"), /not been reviewed/);
  const queries = extractFile(asar, `webview/assets/${queryName}`).toString("utf8");
  const queryPatch = patchCodexBillingQueriesSource(queryName, queries);
  assert.equal(queryPatch.status, "patched");
  parse(queryPatch.source, { ecmaVersion: "latest", sourceType: "module" });
  assert.equal(patchCodexBillingQueriesSource(queryName, queryPatch.source).status, "already-patched");
  assert.throws(() => patchCodexBillingQueriesSource(queryName, queries + "\n"), /not been reviewed/);
});

test("20156 task usage updates unsupported and partial props even when memoized rows are unchanged", { skip: !available }, () => {
  const patched = patchCodexBillingAnalyticsSource(name, source()).source;
  const rows = [{ thread: { id: "thread" }, usage: null }], cache = Array(18).fill(Symbol.for("react.memo_cache_sentinel"));
  let data: any = { rows, analyticsStatus: "full" };
  const context = { ...runtime(cache), Ji: {}, Qi: "chats", na: () => "ready",
    te: () => ({ data, isPending: false, isError: false, isSuccess: true, refetch: () => {} }) };
  const render = runInNewContext(`${functionSource(patched, "Zi")};Zi`, context);
  const props = { accountId: "a", userId: "u", threads: [{}], isPolling: true };
  assert.equal(render(props).props.status, "ready");
  data = { rows, analyticsStatus: "unsupported" };
  assert.equal(render(props).props.status, "unsupported");
  data = { rows, analyticsStatus: "partial" };
  assert.equal(render(props).props.partial, true);
});

test("20156 chat subtitle follows partial status without stale header memoization", { skip: !available }, () => {
  const patched = patchCodexBillingAnalyticsSource(name, source()).source;
  const cache = Array(27).fill(Symbol.for("react.memo_cache_sentinel"));
  const render = runInNewContext(`${functionSource(patched, "Qi")};Qi`, runtime(cache));
  const props = { rows: [], status: "ready", onRetry: () => {}, partial: false };
  assert.equal(render(props).props.children[0].props.subtitle.props.id, "consumerUsage.chats.recentDescription");
  assert.equal(render({ ...props, partial: true }).props.children[0].props.subtitle.props.id, "tweakers.consumerUsage.chats.partialDescription");
  assert.equal(render(props).props.children[0].props.subtitle.props.id, "consumerUsage.chats.recentDescription");
});

test("20156 unsupported task usage renders an unavailable message instead of an empty chat list", { skip: !available }, () => {
  const patched = patchCodexBillingAnalyticsSource(name, source()).source;
  const context = { ...runtime(Array(54).fill(Symbol.for("react.memo_cache_sentinel"))), r: () => false };
  const render = runInNewContext(`${functionSource(patched, "$i")};$i`, context);
  const tree = render({ id: "id", rows: [], status: "unsupported", metrics: [], metric: "balance_usage_credits" });
  assert.equal(tree.props.children.props.id, "tweakers.consumerUsage.chats.unsupported");
});

test("20156 unavailable plan history keeps hooks and renders a truthful unavailable state", { skip: !available }, () => {
  const patched = patchCodexBillingAnalyticsSource(name, source()).source;
  let hooks = 0;
  const context = { ...runtime([]), Ti: { c: () => Array(56).fill(Symbol.for("react.memo_cache_sentinel")) },
    Ei: { useState: (value: unknown) => { hooks++; return [value, () => {}]; } },
    Z: { jsx, jsxs: jsx }, De: () => ({}), yi: () => ({}), Se: () => ({ formatMessage: () => "label" }),
    Oe: () => ({ data: null, isLoading: false, isError: false, refetch: () => {} }),
    x: "icon", s: "tooltip", qr: "group", Si: "period", Ue: () => "grid", __twUsageHistoryContext: "live-context" };
  const render = runInNewContext(`${functionSource(patched, "xi")};xi`, context);
  const tree = render({ isActive: true, isPolling: false, reduceMotion: true });
  assert.equal(hooks, 1);
  assert.equal(tree.props.children[1].props.children[0].props.children.props.id, "tweakers.consumerUsage.limitHistory.unsupported");
});

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "__tweakers_billing_analytics_v1__";
const HISTORY_MARKER = "__tweakers_billing_history_v2__";
const QUERIES_MARKER = "__tweakers_billing_queries_v1__";
const REVIEWED = new Map([
  ["billing-analytics-e2b01d494bbf.js", "45914175c01060de72162ad73c7ebf407d3950cdc29a6c37bc83f8ca3ff3687d"],
  ["billing-analytics-9a493b3c8aaf.js", "f6a8a7ae41c337d73dde1ec46dcc223f54b0326ded8879689d9aadb08c6e93c5"],
  ["billing-analytics-5c7d9d211f3a.js", "26f70808ad4527fa64f86c344deaf43e75849622bf1fc84fbc24fd71017b6401"],
  ["billing-analytics-2f84796974a9.js", "1f540ac1800370eb4976b64cdb33ec8f75c8049b02612630e0930bef65695d8a"],
  ["billing-analytics-98d3dcbc947a.js", "b3059935f861dc31734e0e95fc5e0666cd77f0b5521feb070733506e6f4fc91a"],
  ["billing-analytics-a920e3f98ec7.js", "1a1b5fc9efbaeda5bbc422254197a39f1a589e08f7c85b9b735cf060d711e23b"],
]);
const REVIEWED_V1 = "3ba4c0f49e28a91ea60f727d41dfaaafbb5a4f62fee99e887dd3d8a3b927f3a2";
const REVIEWED_QUERIES = new Map([
  ["queries-9dd30652911e.js", "beaf0a7a3b04345907921503c44d99efb6310ba191058ed4e9d91a9e82a738c4"],
  ["queries-a53713419c4d.js", "914e7261cf5bd63ba28e8fd4e7992baafc3b98704788003fc21f76e7e573a8fb"],
  ["queries-6246c58ed0c3.js", "90a093c26dee13151809a5f6b13ba52ad3e0c6ea37eac7acbd93ff943ab1bfc5"],
  ["queries-6058113866c9.js", "2128194a0f37401be22353597386e1b5a70cdff9e8ed47f666100a854932c3db"],
  ["queries-3238bda4c52d.js", "46a7c923658d8127c4cc887ec52d34c9bac3a60a6a4ca92f81570c6cafe5733c"],
  ["queries-571c444b922f.js", "acae19fc7e896c46f929bc9f2ae0677f5d16a9faaabce418b80e1d5080e357ce"],
]);

export interface BillingAnalyticsPatchResult {
  changed: boolean;
  source: string;
  status: "patched" | "already-patched" | "not-applicable";
}

const hash = (source: string): string => createHash("sha256").update(source).digest("hex");

export function patchCodexBillingAnalyticsSource(name: string, source: string): BillingAnalyticsPatchResult {
  if (source.includes(HISTORY_MARKER)) return { changed: false, source, status: "already-patched" };
  if (name === "billing-analytics-a920e3f98ec7.js" || name === "billing-analytics-e2b01d494bbf.js") return patchCodexBillingAnalytics20156Source(name, source);
  if (name === "billing-analytics-9a493b3c8aaf.js" || name === "billing-analytics-2f84796974a9.js" || name === "billing-analytics-98d3dcbc947a.js") {
    return patchCodexBillingAnalyticsNextSource(name, source);
  }
  const previousPatch = source.includes(MARKER);
  const reviewed = REVIEWED.get(name);
  if (!reviewed) {
    if (name.startsWith("billing-analytics-") && name.endsWith(".js")) throw new Error("This desktop's Billing Analytics component has not been reviewed.");
    return { changed: false, source, status: "not-applicable" };
  }
  if (hash(source) !== (previousPatch ? REVIEWED_V1 : reviewed)) throw new Error("This desktop's Billing Analytics component has not been reviewed.");
  const once = (input: string, anchor: string, replacement: string): string => {
    if (input.split(anchor).length !== 2) throw new Error(`Billing Analytics anchor changed: ${anchor.slice(0, 80)}`);
    return input.replace(anchor, replacement);
  };
  let next = source;
  if (!previousPatch) {
  const queryStart = "queryFn:async({signal:e})=>{let t=[],n=[];for(let i of(0,ba.default)(a,xa)){";
  const queryEnd = ",retry:!1,staleTime:$e.FIVE_MINUTES";
  const from = next.indexOf(queryStart);
  const to = next.indexOf(queryEnd, from + queryStart.length);
  if (from < 0 || to < 0 || next.indexOf(queryStart, from + 1) >= 0 || next.indexOf(queryEnd, to + 1) >= 0) {
    throw new Error("Billing Analytics task query boundaries changed.");
  }
  next = next.slice(0, from)
    + "queryFn:async({signal:e})=>__twBillingAnalyticsRead({client:B,roots:a,scope:r,chunk:ba.default,signal:e,isTruncated:a.length<i.length,discover:t=>xe(r,Le).discoverSubagentDescendantSnapshot(D(t.id),{reconcile:!1})})"
    + next.slice(to);
  next = once(next,
    "let t=await B.safeGet(`/wham/usage/plan_limit_history`,{parameters:{query:{days:7}},signal:e,expectedErrorStatuses:[404]});return qi.parse(t)",
    "let t=await __twBillingAnalyticsPlan(B,e);return t==null?null:qi.parse(t)");
  next = once(next,
    "f=Ma(c,d),t[7]=c,t[8]=d,t[9]=f",
    "f=o?.analyticsStatus===`unsupported`?`unsupported`:Ma(c,d),t[7]=c,t[8]=d,t[9]=f");
  next = once(next,
    "Oa,{rows:u,status:f,onRetry:p}",
    "Oa,{rows:u,status:f,onRetry:p,partial:o?.analyticsStatus===`partial`}");
  next = once(next,
    "{rows:n,status:r,onRetry:i,defaultExpandedThreadId:a}=e",
    "{rows:n,status:r,onRetry:i,defaultExpandedThreadId:a,partial:__twPartial}=e");
  next = once(next,
    "_;t[9]===Symbol.for(`react.memo_cache_sentinel`)?(_=(0,Q.jsx)(J.Header,{title:(0,Q.jsx)(s,{id:`consumerUsage.chats.title`,defaultMessage:`Top chats`,description:`Heading for task usage ranked by the selected allowance or credit metric`}),subtitle:(0,Q.jsx)(s,{id:`consumerUsage.chats.recentDescription`,defaultMessage:`Compare each chat’s plan and credit usage`,description:`At most the 100 most recently active local root chats from the last thirty days are checked. Amounts cover each chat's lifetime including subagents.`})}),t[9]=_):_=t[9];",
    "_=(0,Q.jsx)(J.Header,{title:(0,Q.jsx)(s,{id:`consumerUsage.chats.title`,defaultMessage:`Top chats`,description:`Heading for task usage ranked by the selected allowance or credit metric`}),subtitle:__twPartial?(0,Q.jsx)(s,{id:`tweakers.consumerUsage.chats.partialDescription`,defaultMessage:`Credit usage only; plan attribution and subagent totals are unavailable`,description:`Legacy chat usage fallback when the current analytics service is unavailable`}):(0,Q.jsx)(s,{id:`consumerUsage.chats.recentDescription`,defaultMessage:`Compare each chat’s plan and credit usage`,description:`At most the 100 most recently active local root chats from the last thirty days are checked. Amounts cover each chat's lifetime including subagents.`}),actions:globalThis.__tweakersAccountsNativeV1?.render?.(\"usage\",null,{jsx:Q.jsx,react:vr})??null});");
  next = once(next, "if(i===`error`){", "if(i===`unsupported`){S=(0,Q.jsx)(he,{layout:`settings-row`,children:(0,Q.jsx)(s,{id:`tweakers.consumerUsage.chats.unsupported`,defaultMessage:`Chat usage isn't available for this subscription yet`,description:`Neither current nor legacy chat usage is available for this subscription`})});break bb0}if(i===`error`){");
  next = once(next,
    "let p=C(),[m,h]=(0,na.useState)(`feature`)",
    "let p=C(),[m,h]=(0,na.useState)(`feature`)");
  next = once(next,
    "let L;return t[52]!==F||t[53]!==re?",
    "if(f===`ready`&&d==null)return(0,Z.jsxs)(J,{id:`consumer-plan-history`,children:[(0,Z.jsx)(J.Header,{title:(0,Z.jsx)(s,{id:`consumerAnalyticsPreview.limitHistory.title`,defaultMessage:`Plan usage history`,description:`Analytics section for plan allowance history`})}),(0,Z.jsxs)(J.Content,{className:`gap-3`,children:[(0,Z.jsx)(he,{layout:`settings-row`,children:(0,Z.jsx)(s,{id:`tweakers.consumerUsage.limitHistory.unsupported`,defaultMessage:`Plan usage history isn't available for this subscription yet`,description:`The provider has not made plan history available for this subscription`})}),(0,Z.jsx)(`div`,{\"data-tweakers-analytics-observed-resets\":`true`})]})]});let L;return t[52]!==F||t[53]!==re?");
  next = `/*${MARKER}*/\n;var __twBillingAnalyticsCapabilities=new Map;\n;var __twBillingAnalyticsRead=(${billingAnalyticsRead.toString()});\n;var __twBillingAnalyticsPlan=(${billingAnalyticsPlan.toString()});\n${next}`;
  }
  next = once(next,
    "defaultMessage:`Credits used`,description:`Column heading for the lifetime credits used by a Codex chat`",
    "defaultMessage:`Additional credits used`,description:`Column heading for additional credits used by a Codex chat over its lifetime`");
  next = once(next,
    "defaultMessage:`Compare each chat’s plan and credit usage`,description:`At most the 100 most recently active local root chats from the last thirty days are checked. Amounts cover each chat's lifetime including subagents.`",
    "defaultMessage:`Compare each chat’s lifetime plan and additional credit usage`,description:`At most the 100 most recently active local root chats from the last thirty days are checked. Amounts cover each chat's lifetime including subagents.`");
  next = once(next, "other {Credits used}}`,description:`Chat lifetime usage compared with the current full allowance, or actual purchased/granted credits debited`",
    "other {Additional credits used}}`,description:`Chat lifetime usage compared with the current full allowance, or actual purchased/granted credits debited`");
  next = once(next,
    "children:[x,O]}),t[34]=O,t[35]=x,t[36]=k):k=t[36],k}var Ni,Pi,Fi;",
    "children:[x,(0,Fi.jsx)(__twUsageHistoryContext,{buckets:n,react:Pi,jsx:Fi.jsx}),O]}),t[34]=O,t[35]=x,t[36]=k):k=t[36],k}var Ni,Pi,Fi;");
  next = `/*${HISTORY_MARKER}*/\n;var __twUsageHistoryState=(${usageHistoryState.toString()});\n;var __twUsageHistoryContext=(${usageHistoryContext.toString()});\n${next}`;
  return { changed: true, source: next, status: "patched" };
}

function patchCodexBillingAnalyticsNextSource(name: string, source: string): BillingAnalyticsPatchResult {
  if (hash(source) !== REVIEWED.get(name)) throw new Error("This desktop's Billing Analytics component has not been reviewed.");
  const current = name === "billing-analytics-9a493b3c8aaf.js";
  const client = current ? "at" : "Re";
  const discovery = current ? "Be(i,ot)" : "lt(i,ze)";
  const emptyRow = current ? "Te" : "Qe";
  const once = (input: string, anchor: string, replacement: string): string => {
    if (input.split(anchor).length !== 2) throw new Error(`Billing Analytics anchor changed: ${anchor.slice(0, 80)}`);
    return input.replace(anchor, replacement);
  };
  const queryStart = "queryFn:async({signal:e})=>{let t=[],n=[];for(let r of(0,xi.default)(o,Si)){";
  const queryEnd = ",retry:!1,staleTime:r.FIVE_MINUTES";
  const from = source.indexOf(queryStart);
  const to = source.indexOf(queryEnd, from + queryStart.length);
  if (from < 0 || to < 0 || source.indexOf(queryStart, from + 1) >= 0) throw new Error("Billing Analytics task query boundaries changed.");
  let next = source.slice(0, from)
    + `queryFn:async({signal:e})=>__twBillingAnalyticsRead({client:${client},roots:o,scope:i,chunk:xi.default,signal:e,isTruncated:a.length>o.length,discover:t=>${discovery}.discoverSubagentDescendantSnapshot(de(t.id),{reconcile:!1})})`
    + source.slice(to);
  next = once(next,
    "let t=await " + client + ".safeGet(`/wham/usage/plan_limit_history`,{parameters:{query:{days:7}},signal:e,expectedErrorStatuses:[404]});return Jr.parse(t)",
    "let t=await __twBillingAnalyticsPlan(" + client + ",e);return t==null?null:Jr.parse(t)");
  next = once(next,
    "y=Ni(m,v),t[9]=m,t[10]=v,t[11]=y",
    "y=f?.analyticsStatus===`unsupported`?`unsupported`:Ni(m,v),t[9]=m,t[10]=v,t[11]=y");
  next = once(next,
    "ki,{rows:_,status:y,onRetry:b}",
    "ki,{rows:_,status:y,onRetry:b,partial:f?.analyticsStatus===`partial`}");
  next = once(next,
    "{rows:n,status:r,onRetry:i,defaultExpandedThreadId:a}=e",
    "{rows:n,status:r,onRetry:i,defaultExpandedThreadId:a,partial:__twPartial}=e");
  next = once(next,
    "g=(0,Q.jsx)(J.Header,{title:(0,Q.jsx)(k,{id:`consumerUsage.chats.title`,defaultMessage:`Top chats`,description:`Heading for task usage ranked by the selected allowance or credit metric`}),subtitle:(0,Q.jsx)(k,{id:`consumerUsage.chats.recentDescription`,defaultMessage:`Compare each chat’s plan and credit usage`,description:`At most the 100 most recently active local root chats from the last thirty days are checked. Amounts cover each chat's lifetime including subagents.`})})",
    "g=(0,Q.jsx)(J.Header,{title:(0,Q.jsx)(k,{id:`consumerUsage.chats.title`,defaultMessage:`Top chats`,description:`Heading for task usage ranked by the selected allowance or credit metric`}),subtitle:__twPartial?(0,Q.jsx)(k,{id:`tweakers.consumerUsage.chats.partialDescription`,defaultMessage:`Additional credit usage only; plan attribution and subagent totals are unavailable`,description:`Legacy chat usage fallback when the current analytics service is unavailable`}):(0,Q.jsx)(k,{id:`consumerUsage.chats.recentDescription`,defaultMessage:`Compare each chat’s lifetime plan and additional credit usage`,description:`At most the 100 most recently active local root chats from the last thirty days are checked. Amounts cover each chat's lifetime including subagents.`}),actions:globalThis.__tweakersAccountsNativeV1?.render?.(\"usage\",null,{jsx:Q.jsx,react:Fi})??null})");
  next = once(next, "let h=m,g;t[9]===Symbol.for(`react.memo_cache_sentinel`)?(g=", "let h=m,g;g=");
  next = once(next, "??null}),t[9]=g):g=t[9];let _;", "??null});let _;");
  next = once(next,
    "if(i===`error`){let e;t[19]",
    "if(i===`unsupported`){x=(0,Q.jsx)(" + emptyRow + ",{layout:`settings-row`,children:(0,Q.jsx)(k,{id:`tweakers.consumerUsage.chats.unsupported`,defaultMessage:`Chat usage isn't available for this subscription yet`,description:`Neither current nor legacy chat usage is available for this subscription`})});break bb0}if(i===`error`){let e;t[19]");
  next = once(next,
    "other {Credits used}}`,description:`Chat lifetime usage compared with the current full allowance, or actual purchased/granted credits debited`",
    "other {Additional credits used}}`,description:`Chat lifetime usage compared with the current full allowance, or actual purchased/granted credits debited`");
  next = once(next,
    "defaultMessage:`Credits used`,description:`Column heading for the lifetime credits used by a Codex chat`",
    "defaultMessage:`Additional credits used`,description:`Column heading for additional credits used by a Codex chat over its lifetime`");
  next = once(next,
    "children:[x,D]}),t[38]=x,t[39]=D,t[40]=O):O=t[40],O}var Pr,Fr,Ir;",
    "children:[x,(0,Ir.jsx)(__twUsageHistoryContext,{buckets:n,react:Fr,jsx:Ir.jsx}),D]}),t[38]=x,t[39]=D,t[40]=O):O=t[40],O}var Pr,Fr,Ir;");
  next = `/*${HISTORY_MARKER}*/\n;var __twBillingAnalyticsCapabilities=new Map;\n;var __twBillingAnalyticsRead=(${billingAnalyticsRead.toString()});\n;var __twBillingAnalyticsPlan=(${billingAnalyticsPlan.toString()});\n;var __twUsageHistoryState=(${usageHistoryState.toString()});\n;var __twUsageHistoryContext=(${usageHistoryContext.toString()});\n${next}`;
  return { changed: true, source: next, status: "patched" };
}

/** Exact reviewed 20156 and 20398 carriers: keep its new period tables and the existing fallback semantics. */
function patchCodexBillingAnalytics20156Source(name: string, source: string): BillingAnalyticsPatchResult {
  if (hash(source) !== REVIEWED.get(name)) throw new Error("This desktop's Billing Analytics component has not been reviewed.");
  const once = (anchor: string, replacement: string): void => {
    if (next.split(anchor).length !== 2) throw new Error(`Billing Analytics anchor changed: ${anchor.slice(0, 80)}`);
    next = next.replace(anchor, replacement);
  };
  const queryStart = "queryFn:async({signal:e})=>{let t=[],n=[];for(let i of(0,Wi.default)(a,Gi)){";
  const queryEnd = ",retry:!1,staleTime:Qe.FIVE_MINUTES";
  const from = source.indexOf(queryStart), to = source.indexOf(queryEnd, from + queryStart.length);
  if (from < 0 || to < 0 || source.indexOf(queryStart, from + 1) >= 0) throw new Error("Billing Analytics task query boundaries changed.");
  let next = source.slice(0, from)
    + "queryFn:async({signal:e})=>__twBillingAnalyticsRead({client:V,roots:a,scope:r,chunk:Wi.default,signal:e,isTruncated:i.length>a.length,discover:t=>Xe(r,F).discoverSubagentDescendantSnapshot(Le(t.id),{reconcile:!1})})"
    + source.slice(to);
  once("let t=await V.safeGet(`/wham/usage/plan_limit_history`,{parameters:{query:{days:7}},signal:e,expectedErrorStatuses:[404]});return _i.parse(t)",
    "let t=await __twBillingAnalyticsPlan(V,e);return t==null?null:_i.parse(t)");
  // Compute the fallback status and props on every render, outside memo caches
  // whose upstream dependency list does not contain analyticsStatus.
  once("let b;return t[14]!==g||t[15]!==v||t[16]!==y?(b=(0,Q.jsx)(Qi,{rows:g,status:v,onRetry:y}),t[14]=g,t[15]=v,t[16]=y,t[17]=b):b=t[17],b",
    "return(0,Q.jsx)(Qi,{rows:g,status:d?.analyticsStatus===`unsupported`?`unsupported`:v,onRetry:y,partial:d?.analyticsStatus===`partial`})");
  once("{rows:n,status:r,onRetry:i,defaultExpandedThreadId:a}=e", "{rows:n,status:r,onRetry:i,defaultExpandedThreadId:a,partial:__twPartial}=e");
  once("let g=h,_;t[9]===Symbol.for(`react.memo_cache_sentinel`)?(_=", "let g=h,_;_=");
  once("subtitle:(0,Q.jsx)(J,{id:`consumerUsage.chats.recentDescription`,defaultMessage:`Compare each chat’s plan and credit usage`,description:`At most the 100 most recently active local root chats from the last thirty days are checked. Amounts cover each chat's lifetime including subagents.`})}),t[9]=_):_=t[9];let v;",
    "subtitle:__twPartial?(0,Q.jsx)(J,{id:`tweakers.consumerUsage.chats.partialDescription`,defaultMessage:`Additional credit usage only; plan attribution and subagent totals are unavailable`,description:`Legacy chat usage fallback when the current analytics service is unavailable`}):(0,Q.jsx)(J,{id:`consumerUsage.chats.recentDescription`,defaultMessage:`Compare each chat’s lifetime plan and additional credit usage`,description:`At most the 100 most recently active local root chats from the last thirty days are checked. Amounts cover each chat's lifetime including subagents.`}),actions:globalThis.__tweakersAccountsNativeV1?.render?.(\"usage\",null,{jsx:Q.jsx,react:ia})??null});let v;");
  once("if(a===`error`){let e;t[19]", "if(a===`unsupported`){C=(0,Q.jsx)(ft,{layout:`settings-row`,children:(0,Q.jsx)(J,{id:`tweakers.consumerUsage.chats.unsupported`,defaultMessage:`Chat usage isn't available for this subscription yet`,description:`Neither current nor legacy chat usage is available for this subscription`})});break bb0}if(a===`error`){let e;t[19]");
  once("let b;return t[24]!==v||t[25]!==y?(b=(0,Q.jsxs)(_t,{id:`consumer-top-chats`,children:[_,(0,Q.jsxs)(_t.Content,{className:`gap-3`,children:[v,y]})]}),t[24]=v,t[25]=y,t[26]=b):b=t[26],b",
    "return(0,Q.jsxs)(_t,{id:`consumer-top-chats`,children:[_,(0,Q.jsxs)(_t.Content,{className:`gap-3`,children:[v,y]})]})");
  once("other {Credits used}}`,description:`Chat lifetime usage compared with the current full allowance, or actual purchased/granted credits debited`",
    "other {Additional credits used}}`,description:`Chat lifetime usage compared with the current full allowance, or actual purchased/granted credits debited`");
  once("defaultMessage:`Credits used`,description:`Column heading for the lifetime credits used by a Codex chat`",
    "defaultMessage:`Additional credits used`,description:`Column heading for additional credits used by a Codex chat over its lifetime`");
  once("let z;return t[53]!==F||t[54]!==R?",
    "if(h===`ready`&&m==null)return(0,Z.jsxs)(_t,{id:`consumer-plan-limit-history`,children:[F,(0,Z.jsxs)(_t.Content,{className:`gap-4`,children:[(0,Z.jsx)(ft,{layout:`settings-row`,children:(0,Z.jsx)(J,{id:`tweakers.consumerUsage.limitHistory.unsupported`,defaultMessage:`Plan usage history isn't available for this subscription yet`,description:`The provider has not made plan history available for this subscription`})}),(0,Z.jsx)(__twUsageHistoryContext,{buckets:null,react:Ei,jsx:Z.jsx})]})]});let z;return t[53]!==F||t[54]!==R?");
  once("className:L,children:ee", "className:L,children:[ee,(0,Z.jsx)(__twUsageHistoryContext,{buckets:null,react:Ei,jsx:Z.jsx})]");
  next = `/*${HISTORY_MARKER}*/\n;var __twBillingAnalyticsCapabilities=new Map;\n;var __twBillingAnalyticsRead=(${billingAnalyticsRead.toString()});\n;var __twBillingAnalyticsPlan=(${billingAnalyticsPlan.toString()});\n;var __twUsageHistoryState=(${usageHistoryState.toString()});\n;var __twUsageHistoryContext=(${usageHistoryContext.toString()});\n${next}`;
  return { changed: true, source: next, status: "patched" };
}

export function patchCodexBillingQueriesSource(name: string, source: string): BillingAnalyticsPatchResult {
  if (source.includes(QUERIES_MARKER)) return { changed: false, source, status: "already-patched" };
  const reviewed = REVIEWED_QUERIES.get(name);
  if (!reviewed) {
    return { changed: false, source, status: "not-applicable" };
  }
  if (hash(source) !== reviewed) throw new Error("This desktop's Billing Analytics queries have not been reviewed.");
  const once = (input: string, anchor: string, replacement: string): string => {
    if (input.split(anchor).length !== 2) throw new Error(`Billing Analytics query anchor changed: ${anchor.slice(0, 80)}`);
    return input.replace(anchor, replacement);
  };
  if (name === "queries-571c444b922f.js" || name === "queries-9dd30652911e.js") {
    let next = once(source, "if(p===`consumer`)return r.safeGet(`/wham/usage/credit-usage-events`);", "if(p===`consumer`)return __twBillingCreditEvents(r);");
    next = once(next, "y=()=>r.safeGet(`/wham/usage/daily-token-usage-breakdown`,{parameters:{query:{start_date:_,end_date:g,group_by:`day`}}})", "y=()=>__twBillingDailyHistory(r,_,g)");
    next = `/*${QUERIES_MARKER}*/\n;var __twBillingDailyHistory=(${billingAnalyticsDailyHistory.toString()});\n;var __twBillingCreditEvents=(${billingAnalyticsCreditEvents.toString()});\n${next}`;
    return { changed: true, source: next, status: "patched" };
  }
  const queryClient = name === "queries-a53713419c4d.js" ? "u" : "c";
  const nextQueries = name === "queries-a53713419c4d.js" || name === "queries-6058113866c9.js" || name === "queries-3238bda4c52d.js";
  let next = once(source,
    nextQueries
      ? "if(p===`consumer`)return " + queryClient + ".safeGet(`/wham/usage/credit-usage-events`);"
      : "if(d===`consumer`)return r.safeGet(`/wham/usage/credit-usage-events`);",
    nextQueries
      ? "if(p===`consumer`)return __twBillingCreditEvents(" + queryClient + ");"
      : "if(d===`consumer`)return __twBillingCreditEvents(r);");
  next = once(next,
    nextQueries
      ? "_=()=>" + queryClient + ".safeGet(`/wham/usage/daily-token-usage-breakdown`,{parameters:{query:{start_date:h,end_date:m,group_by:`day`}}})"
      : "h=()=>r.safeGet(`/wham/usage/daily-token-usage-breakdown`,{parameters:{query:{start_date:p,end_date:f,group_by:`day`}}})",
    nextQueries
      ? "_=()=>__twBillingDailyHistory(" + queryClient + ",h,m)"
      : "h=()=>__twBillingDailyHistory(r,p,f)");
  next = `/*${QUERIES_MARKER}*/\n;var __twBillingDailyHistory=(${billingAnalyticsDailyHistory.toString()});\n;var __twBillingCreditEvents=(${billingAnalyticsCreditEvents.toString()});\n${next}`;
  return { changed: true, source: next, status: "patched" };
}

export function patchCodexBillingAnalyticsInExtractedApp(appDir: string): boolean {
  const assets = join(appDir, "webview", "assets");
  if (!existsSync(assets)) return false;
  let matched = false;
  let matchedQueries = false;
  const writes: Array<{ path: string; source: string }> = [];
  for (const name of readdirSync(assets)) {
    if ((!name.startsWith("billing-analytics-") && !name.startsWith("queries-")) || !name.endsWith(".js")) continue;
    const path = join(assets, name);
    const source = readFileSync(path, "utf8");
    const queries = name.startsWith("queries-");
    const result = queries ? patchCodexBillingQueriesSource(name, source) : patchCodexBillingAnalyticsSource(name, source);
    if (result.status === "not-applicable") continue;
    if (queries ? matchedQueries : matched) throw new Error("More than one reviewed Billing Analytics component matched.");
    if (queries) matchedQueries = true;
    else matched = true;
    if (result.changed) writes.push({ path, source: result.source });
  }
  if (matched !== matchedQueries) throw new Error("Billing Analytics component and queries must be patched together.");
  for (const entry of writes) writeFileSync(entry.path, entry.source);
  return matched;
}

export async function billingAnalyticsDailyHistory(client: any, startDate: string, endDate: string): Promise<unknown> {
  const fallback = async () => ({ status: "full", source: "daily_token_usage_breakdown",
    value: await client.safeGet("/wham/usage/daily-token-usage-breakdown", {
      parameters: { query: { start_date: startDate, end_date: endDate, group_by: "day" } },
    }) });
  const bridge = (globalThis as any).__tweakersAccountsNativeV1;
  const result = typeof bridge?.analytics === "function"
    ? await bridge.analytics({ kind: "daily-history", start_date: startDate, end_date: endDate }, fallback)
    : await fallback();
  if (result?.status !== "full") throw new Error(`Daily usage history failed: ${result?.status ?? "unknown"}`);
  return result.value;
}

export async function billingAnalyticsCreditEvents(client: any): Promise<unknown> {
  const fallback = async () => ({ status: "full", source: "credit_usage_events",
    value: await client.safeGet("/wham/usage/credit-usage-events") });
  const bridge = (globalThis as any).__tweakersAccountsNativeV1;
  const result = typeof bridge?.analytics === "function"
    ? await bridge.analytics({ kind: "credit-events" }, fallback)
    : await fallback();
  if (result?.status !== "full") throw new Error(`Credit usage history failed: ${result?.status ?? "unknown"}`);
  return result.value;
}

export function usageHistoryState(buckets: any, context: any, now = new Date()): {
  account: string; weekly: string; pending: string | null; latestRecorded: string | null;
} {
  const account = typeof context?.label === "string" && context.label.trim() ? context.label : "Account unavailable";
  const remaining = context?.remainingPercent;
  const weekly = Number.isFinite(remaining) && remaining >= 0 && remaining <= 100
    ? `Live weekly allowance: ${Math.round(100 - remaining)}% used` : "Live weekly allowance unavailable";
  if (!Array.isArray(buckets)) return { account, weekly, pending: null, latestRecorded: null };
  const positive = (entry: any): boolean => (Array.isArray(entry?.attribution)
    && entry.attribution.some((part: any) => Number.isFinite(part?.value) && part.value > 0))
    || (entry?.product_surface_usage_values && Object.values(entry.product_surface_usage_values)
      .some((value: any) => Number.isFinite(value) && value > 0))
    || (Array.isArray(entry?.models) && entry.models.some((model: any) => Number.isFinite(model?.credits) && model.credits > 0));
  const recorded = buckets.filter((entry: any) => typeof entry?.date === "string" && positive(entry))
    .map((entry: any) => entry.date).sort();
  const latestRecorded = recorded.at(-1) ?? null;
  const reset = typeof context?.resetAt === "string" ? Date.parse(context.resetAt) : NaN;
  if (!(Number.isFinite(remaining) && remaining < 100 && Number.isFinite(reset))) {
    return { account, weekly, pending: null, latestRecorded };
  }
  const weekStart = new Date(reset - 7 * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const currentWeek = buckets.filter((entry: any) => typeof entry?.date === "string"
    && entry.date >= weekStart && entry.date <= today);
  if (currentWeek.length === 0 || currentWeek.some(positive)) {
    return { account, weekly, pending: null, latestRecorded };
  }
  const first = currentWeek.map((entry: any) => entry.date).sort()[0];
  const last = currentWeek.map((entry: any) => entry.date).sort().at(-1);
  const range = first === last ? first : `${first}–${last}`;
  return { account, weekly, pending: `Detailed usage pending for ${range} UTC`, latestRecorded };
}

declare const __twUsageHistoryState: typeof usageHistoryState;

export function usageHistoryContext(props: any): unknown {
  const { buckets, react, jsx } = props;
  const [, rerender] = react.useState(0);
  react.useEffect(() => {
    const refresh = () => rerender((value: number) => value + 1);
    (globalThis as any).addEventListener?.("tweakers:accounts-context", refresh);
    const unsubscribe = (globalThis as any).__tweakersAccountsTransportV1?.subscribe?.(refresh);
    const timer = globalThis.setInterval(refresh, 60_000);
    return () => {
      (globalThis as any).removeEventListener?.("tweakers:accounts-context", refresh);
      if (typeof unsubscribe === "function") unsubscribe();
      globalThis.clearInterval(timer);
    };
  }, []);
  const bridge = (globalThis as any).__tweakersAccountsNativeV1;
  const context = bridge?.project?.("usage", "history-context", null);
  if (!context) return null;
  const state = __twUsageHistoryState(buckets, context);
  const text = `${state.account} · ${state.weekly}`;
  return jsx("div", { className: "px-row-x pt-3 text-sm text-token-text-secondary",
    "data-tweakers-usage-account": context?.accountId ?? "unavailable",
    children: [jsx("div", { children: text }),
      state.latestRecorded ? jsx("div", { children: `Latest recorded: ${state.latestRecorded} UTC` }) : null,
      state.pending ? jsx("div", { role: "status", children: `${state.pending}.` }) : null],
  });
}

export async function billingAnalyticsPlan(client: any, signal: AbortSignal): Promise<unknown | null> {
  const fallback = async () => {
    try {
      const value = await client.safeGet("/wham/usage/plan_limit_history", { parameters: { query: { days: 7 } }, signal, expectedErrorStatuses: [404] });
      return { status: "full", source: "plan_limit_history", value };
    } catch (error) {
      if ((error as any)?.status === 404) return { status: "unsupported", source: "plan_limit_history", value: null };
      throw error;
    }
  };
  const bridge = (globalThis as any).__tweakersAccountsNativeV1;
  const result = typeof bridge?.analytics === "function"
    ? await bridge.analytics({ kind: "plan-history", days: 7 }, fallback)
    : await fallback();
  if (result?.status === "unsupported") return null;
  if (result?.status !== "full") throw new Error(`Plan usage history failed: ${result?.status ?? "unknown"}`);
  return result.value;
}

export async function billingAnalyticsRead(input: any): Promise<any> {
  const { client, roots, scope, chunk, signal, isTruncated, discover } = input;
  const bridge = (globalThis as any).__tweakersAccountsNativeV1;
  const capabilityKey = typeof bridge?.key === "function" ? bridge.key("usage") : "native";
  const capabilities: Map<string, "query_v1" | "query_v2"> = (globalThis as any).__twBillingAnalyticsCapabilities ?? new Map();
  const row = (thread: any, descendants: string[] = []) => ({
    thread_id: thread.id,
    created_at: Number.isFinite(thread.createdAt) && thread.createdAt > 0 ? new Date(thread.createdAt * 1e3).toISOString() : null,
    descendant_thread_ids: descendants,
  });
  const normalizeLegacy = (value: any) => ({
    threads: Array.isArray(value?.threads) ? value.threads.flatMap((thread: any) => {
      if (!thread || typeof thread.thread_id !== "string") return [];
      const credits = Number(thread.estimated_usage_credits_micros);
      return [{
        thread_id: thread.thread_id,
        data_status: "partial",
        five_hour_limit_percent: null,
        weekly_limit_percent: null,
        balance_usage_credits: Number.isFinite(credits) && credits >= 0 ? credits / 1e6 : null,
        groups: Array.isArray(thread.groups) ? thread.groups.map((group: any) => ({
          ...group,
          five_hour_limit_percent: null,
          weekly_limit_percent: null,
          balance_usage_credits: Number.isFinite(Number(group?.estimated_usage_credits_micros)) ? Number(group.estimated_usage_credits_micros) / 1e6 : null,
        })) : [],
      }];
    }) : [],
    data_as_of: null,
    tweakers_status: "partial",
    tweakers_source: "query_v1",
  });
  const direct = async (threads: any[], preferredSource?: "query_v1") => {
    if (preferredSource !== "query_v1") {
      try {
        return { status: "full", source: "query_v2", value: await client.safePost("/wham/usage/thread_usage/query_v2", { requestBody: { threads }, signal }) };
      } catch (error) {
        if ((error as any)?.status !== 404) throw error;
      }
    }
    try {
      const legacy = async (threadIds: string[]): Promise<any> => {
        try { return await client.safePost("/wham/usage/thread_usage/query", { requestBody: { thread_ids: threadIds }, signal }); }
        catch (error) {
          if ((error as any)?.status !== 503) throw error;
          if (threadIds.length === 1) return { threads: [] };
          const middle = Math.ceil(threadIds.length / 2);
          const [left, right] = await Promise.all([legacy(threadIds.slice(0, middle)), legacy(threadIds.slice(middle))]);
          return { threads: [...(left?.threads ?? []), ...(right?.threads ?? [])] };
        }
      };
      const value = await legacy(threads.map((thread) => thread.thread_id));
      return { status: "partial", source: "query_v1", value: normalizeLegacy(value) };
    } catch (error) {
      if ((error as any)?.status === 404) return { status: "unsupported", source: "query_v1", value: null };
      throw error;
    }
  };
  const read = (threads: any[], preferredSource?: "query_v1") => typeof bridge?.analytics === "function"
    ? bridge.analytics({ kind: "thread-usage", ...(preferredSource ? { preferred_source: preferredSource } : {}), threads }, () => direct(threads, preferredSource))
    : direct(threads, preferredSource);
  if (!roots.length) return { isTruncated, dataAsOf: null, analyticsStatus: "full", rows: [] };
  signal.throwIfAborted();
  const known = capabilities.get(capabilityKey);
  const probe = await read([row(roots[0])], known === "query_v1" ? "query_v1" : undefined);
  signal.throwIfAborted();
  if (probe?.status === "unsupported") {
    return { isTruncated, dataAsOf: null, analyticsStatus: "unsupported", rows: roots.map((thread: any) => ({ thread, usage: null, subagentCount: null })) };
  }
  if (probe?.status !== "full" && probe?.status !== "partial") throw new Error(`Chat usage failed: ${probe?.status ?? "unknown"}`);
  capabilities.set(capabilityKey, probe.status === "partial" ? "query_v1" : "query_v2");
  const groups: any[] = [];
  const rows: any[] = [];
  if (probe.status === "partial") {
    for (const batch of chunk(roots, 100)) groups.push(batch.map((thread: any) => row(thread)));
    rows.push(...roots.map((thread: any) => ({ thread, usage: null, subagentCount: null })));
  } else {
    for (const pair of chunk(roots, 2)) {
      signal.throwIfAborted();
      const snapshots = await new Promise<any[]>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Analytics cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        Promise.all(pair.map((thread: any) => Promise.resolve().then(() => discover(thread))))
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      pair.forEach((thread: any, index: number) => {
        const snapshot = snapshots[index];
        const descendants = [...new Set<string>(snapshot.descendantThreads.map(({ id }: any) => String(id)))];
        rows.push({ thread, usage: null, subagentCount: snapshot.isComplete ? descendants.length : null });
        if (snapshot.isComplete && descendants.length < 1_000) groups.push([row(thread, descendants)]);
      });
    }
  }
  const responses: any[] = [];
  for (const pair of chunk(groups, 2)) {
    signal.throwIfAborted();
    responses.push(...await Promise.all(pair.map((threads: any[]) => read(threads, probe.status === "partial" ? "query_v1" : undefined))));
  }
  const unsupported = responses.some((result) => result?.status === "unsupported");
  if (unsupported) return { isTruncated, dataAsOf: null, analyticsStatus: "unsupported", rows };
  const partial = probe.status === "partial" || responses.some((result) => result?.status === "partial");
  const values = responses.map((result) => result.value).filter(Boolean);
  const usage = new Map(values.flatMap((value: any) => (value.threads ?? []).map((thread: any) => [thread.thread_id, thread])));
  const asOf = values.map((value: any) => value.data_as_of).filter((value: any) => value != null).sort((a: string, b: string) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return { isTruncated, dataAsOf: asOf, analyticsStatus: partial ? "partial" : "full", rows: rows.map((entry) => ({ ...entry, usage: usage.get(entry.thread.id) ?? null })) };
}

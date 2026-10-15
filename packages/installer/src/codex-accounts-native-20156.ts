import { createHash } from "node:crypto";
import { parse } from "acorn";
import { ACCOUNTS_NATIVE_20156_ASSETS, ACCOUNTS_NATIVE_20156_COMPANIONS, ACCOUNTS_NATIVE_REQUIRED_HOOKS, validateAccountsNativeCompatibility, type AccountsNativeCompatibilityRecordV1 } from "@therealityreport/tweakers-sdk";
import { nativeBootstrapSource, type AccountsNativePatchResult } from "./codex-accounts-native.js";
import { patchAccountsNative20156MainSources, validateAccountsNative20156MainCarriers } from "./codex-accounts-native-20156-main.js";
const MARKER = "__tweakers_accounts_native_v1__";
const BRIDGE = "globalThis.__tweakersAccountsNativeV1";
const PREFIX = "webview/assets/";
const BUILD = "26.1007.30912";
const SHARED = "app-shared-8bd9d0399038.js", DATA = "app-initial-6350d04672d0.js";
const MENU = "profile-dropdown-items-d842ad78cd70.js", PROFILE = "profile-d4ec050a2b68.js";
const APPS = "apps-availability-602b68c7254e.js", PLUGINS = "plugins-settings-39f4509a79cc.js";
const MCP = "mcp-settings-83d0520492d3.js", THREAD = "local-conversation-thread-c8c5e92ea89e.js", USAGE = "page-400328cd46f4.js";
const REVIEWED_ASSETS: Readonly<Record<string, readonly string[]>> = {
  "app-shared-8bd9d0399038.js": [
    "607ad0866dd25ed3764711b4467a9b60708353a599485b5249ff4cbe0e870245",
    "928fe2c0b0bf44bb1059369088eea7927207979d29ff43df87f31cf8def449ed",
    // Reviewed 20156 retention v2 preserves active and waiting chats.
    "42162d3da2a6a07d3006d062c905c7a679c2908b08ffce22f2a3b8b8f4f90f83"
  ],
  "app-initial-6350d04672d0.js": [
    "604b5d2de4fbb41f3d0dc5b3662129c558e1c7b8aac8cc87225286f58dcfaf8f"
  ],
  "profile-dropdown-items-d842ad78cd70.js": [
    "a9a1c931a669cd467ca739c191be192d35be131fb8f1cefd212e150818f19758"
  ],
  "profile-d4ec050a2b68.js": [
    "5529400fd9b0b3c4ba832da6c5c47f41e328876038d80accec5a7e150c3275ec"
  ],
  "apps-availability-602b68c7254e.js": [
    "5e93a269faa5d50029b7b64084f5a2dd6aaf25b6f546177b5b3949c6b98ba272"
  ],
  "plugins-settings-39f4509a79cc.js": [
    "55dd3300fb2ec44bf06dd2a2dca754080e89186e898cf228d0967d82a09a588b"
  ],
  "mcp-settings-83d0520492d3.js": [
    "0dd071dcc5e23544b0237bf6d23c5418d62858a24cdd39e0017dd336d07e9c68"
  ],
  "local-conversation-thread-c8c5e92ea89e.js": [
    "ee192ab3f19d493d64580f7690c94b05c589fe59c1757984e1c5a076976a47eb"
  ],
  "page-400328cd46f4.js": [
    "ef7b40c7e3ddb2820f73868f1afe04dfb12c2d53bc704c56df35a8d04f2646f3"
  ]
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
/** Exact reviewed 20156 relocation; prepare every edit atomically. */
export function patchCodexAccountsNative20156Sources(sources: ReadonlyMap<string, string>, previousRecord?: unknown): AccountsNativePatchResult {
  const hooks = [...ACCOUNTS_NATIVE_REQUIRED_HOOKS], hookSetSha256 = digest(JSON.stringify(hooks));
  const unavailable = (reason: string): AccountsNativePatchResult => ({changed:false,sources:new Map(sources),record:{version:1,bridgeVersion:1,build:BUILD,status:"unavailable",hooks,hookSetSha256,assets:[],reason}});
  for (const [path, expected] of Object.entries(ACCOUNTS_NATIVE_20156_COMPANIONS)) {
    if (!sources.has(path) || digest(sources.get(path)!) !== expected) return unavailable("A reviewed Accounts companion is missing or changed: " + path);
  }
  const families = ["app-initial", "app-shared", "app-primary", "profile", "apps-availability", "plugins-settings", "mcp-settings", "local-conversation-thread", "page"];
  for (const [path, source] of sources) {
    if (!families.some(family => path.startsWith(PREFIX + family + "-"))) continue;
    if (!REVIEWED_ASSETS[path.slice(PREFIX.length)] && ACCOUNTS_NATIVE_20156_COMPANIONS[path] !== digest(source)) return unavailable("Accounts carrier inventory changed: " + path);
  }
  try { validateAccountsNative20156MainCarriers(sources); } catch (error) { return unavailable((error as Error).message); }
  if ([...sources.values()].some(source => source.includes(MARKER))) {
    const status = validateAccountsNativeCompatibility(previousRecord, path => { if (!sources.has(path)) throw Error("missing asset"); return sources.get(path)!; }, digest);
    if (!status.compatible || status.build !== BUILD) return unavailable(status.reason ?? "Accounts build changed.");
    return {changed:false,sources:new Map(sources),record:previousRecord as AccountsNativeCompatibilityRecordV1};
  }
  for (const [name, hashes] of Object.entries(REVIEWED_ASSETS)) if (!sources.has(PREFIX + name) || !hashes.includes(digest(sources.get(PREFIX + name)!))) return unavailable("This desktop's Accounts components have not been reviewed. Native behavior was preserved.");
  const result = new Map(sources);
  const once = (source: string, anchor: string, replacement: string) => {
    if (source.split(anchor).length !== 2) throw Error("Accounts native hook must match exactly once: " + anchor);
    return source.replace(anchor, () => replacement);
  };
  const edit = (name: string, anchor: string, replacement: string) => result.set(PREFIX + name, once(result.get(PREFIX + name)!, anchor, replacement));
  const region = (name: string, start: string, end: string, transform: (source: string) => string) => {
    const source = result.get(PREFIX + name)!;
    if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error("Accounts native flow boundaries changed: " + start);
    const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
    if (to < from) throw Error("Accounts native flow order changed.");
    result.set(PREFIX + name, source.slice(0, from) + transform(source.slice(from, to)) + source.slice(to));
  };
  try {
    for (const [path, source] of patchAccountsNative20156MainSources(sources, hookSetSha256)) result.set(path, source);
    region(DATA, "function M0r(", "function I0r(", source => {
      source = once(source, "O=async e=>{if(e.preventDefault()", "O=async e=>{const __twProjectForm=e.currentTarget;if(e.preventDefault()");
      return once(source, "{T(!1);return}l()}catch(e)", '{T(!1);return}try{__twProjectForm?.dispatchEvent(new CustomEvent("tweaker:project-save-succeeded",{detail:{projectId:d}}))}catch{}l()}catch(e)');
    });
    edit(SHARED, "defaultQueryOptions(e){if(e._defaulted)return e;", `defaultQueryOptions(e){e=${BRIDGE}.options(e);if(e._defaulted)return e;`);
    for (const anchor of ["getQueriesData(e){", "setQueriesData(e,t,n){", "removeQueries(e){", "resetQueries(e,t){", "cancelQueries(e,t={}){", "invalidateQueries(e,t={}){", "refetchQueries(e,t={}){"]) edit(SHARED, anchor, `${anchor}e=${BRIDGE}.filter(e);`);
    edit(SHARED, "function Fct(e,t,n,{cacheSubscriptions:r,getEnabledReaderOptions:i,getShouldSuppressStaleFetchOnEnable:a,isEnabledReaderMounting:o,shouldRetainFetchStartedAfterUnmount:s}){let c=iO(0)", `function Fct(e,t,n,{cacheSubscriptions:r,getEnabledReaderOptions:i,getShouldSuppressStaleFetchOnEnable:a,isEnabledReaderMounting:o,shouldRetainFetchStartedAfterUnmount:s}){let __twAccountsEpoch=${BRIDGE}.signalEpoch(iO);let c=iO(0)`);
    edit(SHARED, "i=jct(n(t).defaultQueryOptions(e(t)))", `i=jct(n(t).defaultQueryOptions(${BRIDGE}.signalOptions(e(t),t,__twAccountsEpoch)))`);
    edit(SHARED, "let t=jct(n(e).defaultQueryOptions(i(e)));return g(t),t", `let t=jct(n(e).defaultQueryOptions(${BRIDGE}.signalOptions(i(e),e,__twAccountsEpoch)));return g(t),t`);
    edit(SHARED, "async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);return e===`config/read`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===`plugin/list`&&n?.timeoutMs==null?{...n,timeoutMs:_pn}:n)}", `async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(\`AppServerRequestClient is missing a message dispatcher\`);return ${BRIDGE}.rpc(e,t,()=>e===\`config/read\`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===\`plugin/list\`&&n?.timeoutMs==null?{...n,timeoutMs:_pn}:n))}`);
    edit(SHARED, "o=JSON.stringify({options:a,params:n}),s=t.get(o)", `o=JSON.stringify({options:a,params:n,accountsScope:${BRIDGE}.key("mcp")}),s=t.get(o)`);
    edit(PLUGINS, "_e(Pt,It)", '_e(Pt,{...It,accountsNativeSurface:"mcp"})');
    edit(PLUGINS, "_e(r,u)", '_e(r,{...u,accountsNativeSurface:"mcp"})');
    region(SHARED, "function Ljn(e,t){", "function Rjn(", source => once(source, "VP(p)}", `VP(${BRIDGE}.configOptions(t?.accountsNativeSurface,p,false,c))}`));
    edit(SHARED, "async function rMn(e,t,n){let{layers:r}=await Wq(e,t,n,null,!0);return Gq(r)}", `async function rMn(e,t,n,__twCaptured){let{layers:r}=await ${BRIDGE}.configRead(__twCaptured,()=>Wq(e,t,n,null,!0));return Gq(r)}`);
    edit(APPS, "O=async e=>{let{appId:t,enabled:n}=e,r=await h(s,d,o);if((await E(s,o).sendRequest(`config/batchWrite`,{edits:L({appId:t,enabled:n}),filePath:r?.filePath??null,expectedVersion:r?.expectedVersion??null,reloadUserConfig:!0})).status===`okOverridden`)", `O=async e=>{let __twCaptured=${BRIDGE}.mutationScope("apps",e);let{appId:t,enabled:n}=e,r=await h(s,d,o,__twCaptured);if((await ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:L({appId:t,enabled:n}),filePath:r?.filePath??null,expectedVersion:r?.expectedVersion??null,reloadUserConfig:!0},()=>E(s,o).sendRequest(\`config/batchWrite\`,{edits:L({appId:t,enabled:n}),filePath:r?.filePath??null,expectedVersion:r?.expectedVersion??null,reloadUserConfig:!0}))).status===\`okOverridden\`)`);
    edit(APPS, "let P=w(N)", `let P=${BRIDGE}.mutationHandle("apps",w(${BRIDGE}.mutation("apps",N)))`);
    edit(APPS, "await d.cancelQueries({queryKey:C});let r=", `await d.cancelQueries({queryKey:C});${BRIDGE}.mutationScope("apps",e);let r=`);
    edit(APPS, "(await g(C),d.getQueryData(C)", `(await g(C),${BRIDGE}.mutationScope("apps",t),d.getQueryData(C)`);
    region(SHARED, "function Xjn(e){", "function Zjn(", source => {
      source = once(source, "u=e=>{let{key:t,enabled:i}=e;return KI(n,r).sendRequest(`config/value/write`,{keyPath:`mcp_servers.${t}.enabled`,value:i,mergeStrategy:`upsert`,filePath:null,expectedVersion:null})}", `u=e=>{let __twCaptured=${BRIDGE}.mutationScope("mcp",e);let{key:t,enabled:i}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"config/value/write",{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:"upsert",filePath:null,expectedVersion:null},()=>KI(n,r).sendRequest(\`config/value/write\`,{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:"upsert",filePath:null,expectedVersion:null}))}`);
      source = once(source, "await Promise.all([i.cancelQueries({queryKey:s}),i.cancelQueries({queryKey:l})]);let r=", `await Promise.all([i.cancelQueries({queryKey:s}),i.cancelQueries({queryKey:l})]);${BRIDGE}.mutationScope("mcp",e);let r=`);
      source = source.replaceAll("queryKey:l", `queryKey:${BRIDGE}.scopedKey("mcp",l)`);
      source = once(source, "Zjn(i,l)", `Zjn(i,${BRIDGE}.scopedKey("mcp",l))`);
      source = once(source, "m=async()=>{await a([...Yq,r]),await a([...qq,r])}", `m=async(__twResult,__twError,__twVariables)=>{let __twCaptured=${BRIDGE}.mutationScope("mcp",__twVariables);await a([...Yq,r]);${BRIDGE}.ensure(__twCaptured);await a([...qq,r]);${BRIDGE}.ensure(__twCaptured)}`);
      source = once(source, "a([...Yq,r])", `a(${BRIDGE}.scopedKey("mcp",[...Yq,r]))`);
      source = once(source, "a([...qq,r])", `a(${BRIDGE}.scopedKey("mcp",[...qq,r]))`);
      return once(source, ",GP(h)}", `,${BRIDGE}.mutationHandle("mcp",GP(${BRIDGE}.mutation("mcp",h)))}`);
    });
    region(SHARED, "function Jjn(e){", "function Yjn(", source => {
      source = once(source, "a=e=>{let{filePath:t,key:i,value:a}=e;return KI(n,r).sendRequest(`config/batchWrite`,{edits:[{keyPath:`mcp_servers.${i}`,value:a,mergeStrategy:`replace`}],filePath:t,expectedVersion:null})}", `a=e=>{let __twCaptured=${BRIDGE}.mutationScope("mcp",e);let{filePath:t,key:i,value:a}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:[{keyPath:\`mcp_servers.\${i}\`,value:a,mergeStrategy:"replace"}],filePath:t,expectedVersion:null},()=>KI(n,r).sendRequest(\`config/batchWrite\`,{edits:[{keyPath:\`mcp_servers.\${i}\`,value:a,mergeStrategy:"replace"}],filePath:t,expectedVersion:null}))}`);
      source = once(source, "o=async()=>{await Qjn(r,i)}", `o=async(__twResult,__twVariables)=>{let __twCaptured=${BRIDGE}.mutationScope("mcp",__twVariables);await Qjn(r,i,__twCaptured);${BRIDGE}.ensure(__twCaptured)}`);
      return once(source, ",GP(s)}", `,${BRIDGE}.mutationHandle("mcp",GP(${BRIDGE}.mutation("mcp",s)))}`);
    });
    edit(SHARED, "async function Qjn(e,t){await t([...Yq,e]),await Promise.all([t([...qq,e]),t([...Xq,e])])}", `async function Qjn(e,t,__twCaptured){${BRIDGE}.ensure(__twCaptured);await t(${BRIDGE}.scopedKey("mcp",[...Yq,e]));${BRIDGE}.ensure(__twCaptured);await Promise.all([t(${BRIDGE}.scopedKey("mcp",[...qq,e])),t(${BRIDGE}.scopedKey("mcp",[...Xq,e]))]);${BRIDGE}.ensure(__twCaptured)}`);
    edit(DATA, "let e=await $l.safeGet(`/wham/profiles/me`)", `let __twNativeProfile=await $l.safeGet(\`/wham/profiles/me\`);let e=await ${BRIDGE}.request("profile","profile.statistics",{native:__twNativeProfile},()=>__twNativeProfile)`);
    edit(SHARED, "M2r=Wk(X,`polling`,", `__twAccountsUsageEpoch=Wk(X,0,({set:t})=>{let n=0;return ${BRIDGE}.subscribe("usage",()=>t(++n))}),M2r=Wk(X,\`polling\`,`);
    edit(SHARED, "h4=J(X,({get:e})=>{let t=e(N2r),n=e(AG),r=e(OG);", `h4=J(X,({get:e})=>{e(__twAccountsUsageEpoch);let t=${BRIDGE}.key("usage")==="native"?e(N2r):"polling",n=e(AG),r=e(OG);`);
    edit(SHARED, 'return h2r(await FW.safeGet(`/wham/usage`,{additionalHeaders:{"OAI-App-Brand":G0r.toLowerCase(),"x-openai-codex-pricing-chooser":`1`,...e},signal:t}))', `return ${BRIDGE}.usage(h2r(await FW.safeGet(\`/wham/usage\`,{additionalHeaders:{"OAI-App-Brand":G0r.toLowerCase(),"x-openai-codex-pricing-chooser":\`1\`,...e},signal:t})))`);
    edit(DATA, "function YRr(){return $l.safeGet(`/wham/rate-limit-reset-credits`)}", `function YRr(){return ${BRIDGE}.request("usage","usage.credits.read",{},()=>$l.safeGet(\`/wham/rate-limit-reset-credits\`))}`);
    region(DATA, "function XRr(){", "function ZRr(e){", source => once(source, "wh(r)}", `${BRIDGE}.mutationHandle("usage",wh(${BRIDGE}.mutation("usage",r)))}`));
    edit(DATA, "function ZRr(e){let{creditId:t,redeemRequestId:n}=e;return $l.safePost(`/wham/rate-limit-reset-credits/consume`,{requestBody:{credit_id:t,redeem_request_id:n}})}", `function ZRr(e){let __twCaptured=${BRIDGE}.mutationScope("usage",e);let{creditId:t,redeemRequestId:n}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"usage.credits.consume",{creditId:t,redeemRequestId:n},()=>$l.safePost(\`/wham/rate-limit-reset-credits/consume\`,{requestBody:{credit_id:t,redeem_request_id:n}}))}`);
    region(SHARED, "async function Rqr(", "async function zqr(", source => {
      source = once(source, "{let x=aqr(i.id,a)", `{let __twAppsScope=${BRIDGE}.capture("apps");if(__twAppsScope&&(_!=null||b!=null))return{kind:"failed"};let x=aqr(i.id,a)`);
      source = once(source, "m.fetchQuery(Pqr(i.id,{productSku:x?.productSku}))", `m.fetchQuery(${BRIDGE}.scopedQuery(Pqr(i.id,{productSku:x?.productSku}),__twAppsScope))`);
      source = once(source, "catch(e){return zf.error", 'catch(e){if(__twAppsScope)return{kind:"failed"};return zf.error');
      source = once(source, "if(qqr(C)||w===`UNSUPPORTED`)return nJr", 'if(__twAppsScope&&w===`API_KEY`)return{kind:"failed"};if(qqr(C)||w===`UNSUPPORTED`)return __twAppsScope?{kind:"failed"}:nJr');
      source = once(source, "catch(t){return v?.aborted", 'catch(t){if(__twAppsScope)return{kind:"failed"};return v?.aborted');
      return source.replaceAll("FW.safePost(", `${BRIDGE}.http(FW,"safePost",__twAppsScope)(`);
    });
    region(SHARED, "async function zqr(", "function Qqr(", source => {
      source = once(source, "{if(i===`missing_link`)", `{let __twAppsScope=${BRIDGE}.capture("apps");if(__twAppsScope&&p!=null)return{kind:"failed"};if(i===\`missing_link\`)`);
      source = once(source, "catch(i){if(k2", 'catch(i){if(__twAppsScope)return{kind:"failed"};if(k2');
      source = once(source, "if(!t)return{kind:`failed`}", 'if(!t||__twAppsScope)return{kind:`failed`}');
      return source.replaceAll("FW.safePost(", `${BRIDGE}.http(FW,"safePost",__twAppsScope)(`);
    });
    edit(DATA, "if(O=!0,S())return{kind:`missing-callback-data`}", `if(O=!0,__twAppsScope=${BRIDGE}.oauthResultCapture(e,__twAppsScope),!${BRIDGE}.oauthResultCurrent(e)){x!=null&&dA(n,x);o({oauthState:b});E!=null&&qAn.delete(E);return{kind:"success",appId:e.link.connector_id,appName:e.link?.name?.trim()||g?.appName||"App"}}if(S())return{kind:\`missing-callback-data\`}`);
    region(DATA, "function xAn(){", "function SAn(", guardOAuthContinuation);
    edit(DATA, "async function tKt({scope:e,accountId:t,hostId:n,queryClient:r,shouldUseNewAppLifecycle:i}){let a=", `async function tKt({scope:e,accountId:t,hostId:n,queryClient:r,shouldUseNewAppLifecycle:i,accountsCapture:__twCaptured}){${BRIDGE}.ensure(__twCaptured);let a=`);
    edit(DATA, "await hKt({scope:e,forceRefetch:!0,hostId:a,shouldUseNewAppLifecycle:i}),r.setQueryData", `await hKt({scope:e,forceRefetch:!0,hostId:a,shouldUseNewAppLifecycle:i,accountsCapture:__twCaptured}),${BRIDGE}.ensure(__twCaptured),r.setQueryData`);
    edit(DATA, "async function hKt({scope:e,forceRefetch:t,hostId:n,shouldUseNewAppLifecycle:r})", "async function hKt({scope:e,forceRefetch:t,hostId:n,shouldUseNewAppLifecycle:r,accountsCapture:__twCaptured})");
    edit(DATA, "sendRequest:(t,r,i)=>jg(e,n).sendRequest(t,r,i),runLegacyRead:async e=>{try{return await VIe", `sendRequest:(t,r,i)=>${BRIDGE}.capturedRpc(__twCaptured,t,r,()=>jg(e,n).sendRequest(t,r,i)),runLegacyRead:async e=>{${BRIDGE}.ensure(__twCaptured);try{return await VIe`);
    // Only exact reviewed account HTTP paths are wrapped. New unsupported routes remain
    // native unless a captured connector flow above explicitly refuses their variant.
    const paths = new Set(["/aip/connectors/{connector_id}", "/aip/connectors/{connector_id}/link", "/wham/github/installations/v2", "/aip/connectors/links/list_accessible", "/aip/connectors/links/noauth", "/aip/connectors/links/oauth", "/aip/connectors/links/oauth/complete", "/aip/connectors/links/oauth/reauth", "/aip/connectors/links/oauth/callback", "/aip/connectors/github/has_installations"]);
    for (const name of [DATA, SHARED]) result.set(PREFIX + name, result.get(PREFIX + name)!.replace(/(\$l|FW)\.safe(Get|Post)\((`[^`]+`)/g, (original, client: string, verb: string, literal: string) => paths.has(literal.slice(1,-1)) ? `${BRIDGE}.http(${client},"safe${verb}")(${literal}` : original));
    // These components shadow their native React import aliases with a local
    // menu boolean and profile scroll callback. Use the shared React factory.
    for (const name of [MENU, PROFILE]) result.set(PREFIX + name, `import{PCn as __twAccountsReact}from"./${SHARED}";\n` + result.get(PREFIX + name));
    edit(MENU, "usageItems:k})", `usageItems:${BRIDGE}.render("account-menu",k,{jsx:$.jsx,react:__twAccountsReact()})})`);
    edit(PROFILE, "className:`relative isolate flex flex-col items-center`,style:bi,children:[Si,Ci]", `className:\`relative isolate flex flex-col items-center\`,style:bi,children:[Si,Ci,${BRIDGE}.render("profile",null,{jsx:$.jsx,react:__twAccountsReact()})]`);
    edit(PLUGINS, "className:`flex h-full min-h-0 flex-col`,children:[qi,(0,$.jsx)(`div`,", `className:\`flex h-full min-h-0 flex-col\`,children:[qi,${BRIDGE}.render("plugins",null,{jsx:$.jsx,react:po}),${BRIDGE}.render("apps",null,{jsx:$.jsx,react:po}),(0,$.jsx)(\`div\`,`);
    result.set(PREFIX + MCP, `import{PCn as __twAccountsReact}from"./${SHARED}";\n` + result.get(PREFIX + MCP));
    edit(MCP, "children:(0,p.jsx)(u,{manageOnly:!0})", `children:[${BRIDGE}.render("mcp",null,{jsx:p.jsx,react:__twAccountsReact()}),(0,p.jsx)(u,{manageOnly:!0})]`);
    edit(THREAD, "children:[y,b,x,S,C,w,T,E]", `children:[y,b,x,S,C,${BRIDGE}.render("thread-summary",null,{jsx:dE.jsx,react:uE}),w,T,E]`);
    edit(USAGE, "children:[null,(0,$.jsx)(Nu,{isPolling:r})]", `children:[${BRIDGE}.render("usage",null,{jsx:$.jsx,react:Uu}),(0,$.jsx)(Nu,{isPolling:r})]`);
    edit(DATA, "usageWindows:a,now:o}=e,s=zd()", `usageWindows:__twNativeWindows,now:o}=e,a=${BRIDGE}.project("usage","windows",__twNativeWindows),s=zd()`);
    result.set(PREFIX + SHARED, "var __twAccountsUsageEpoch;\n" + nativeBootstrapSource(hookSetSha256) + "\n" + result.get(PREFIX + SHARED));
    for (const name of Object.keys(REVIEWED_ASSETS).filter(name => name !== SHARED)) result.set(PREFIX + name, `/*${MARKER}*/\n` + result.get(PREFIX + name));
  } catch (error) { return unavailable(error instanceof Error ? error.message : "Accounts native anchors changed."); }
  const assets = ACCOUNTS_NATIVE_20156_ASSETS.map(path => ({path,sha256:digest(result.get(path)!)}));
  return {changed:true,sources:result,record:{version:1,bridgeVersion:1,build:BUILD,status:"compatible",hooks,hookSetSha256,assets}};
}

/** Bind every awaited continuation and query operation in the exact reviewed callback. */
function guardOAuthContinuation(source: string): string {
  const once = (anchor: string, replacement: string) => {
    if (source.split(anchor).length !== 2) throw Error("Accounts OAuth continuation anchor changed: " + anchor);
    source = source.replace(anchor, () => replacement);
  };
  once("u=async e=>{let{callbackReceivedAtMs:u,", `u=async e=>{let __twAppsScope=${BRIDGE}.capture("apps");const __twQueries=${BRIDGE}.boundQueryClient(()=>__twAppsScope,r);let{callbackReceivedAtMs:u,`);
  once("S=()=>{let e=n.get(Lh)", `S=()=>{if(!${BRIDGE}.isCurrent(__twAppsScope)){o({oauthState:b});x!=null&&dA(n,x);b!=null&&qAn.delete(b);return true}let e=n.get(Lh)`);
  // These native resume chains perform internal asynchronous account writes.
  // Only the reviewed direct Apps callback has a scoped continuation contract.
  once("if(S())return{kind:`missing-callback-data`};if(h.length===0)", `if(__twAppsScope&&(g?.resumeTarget.kind!=="apps-tab"||g?.pluginInstallOAuthState!=null))return{kind:"request-failed"};if(S())return{kind:\`missing-callback-data\`};if(h.length===0)`);
  once("x!=null&&Ykn(n,x,r).catch(SAn)", "x!=null&&!__twAppsScope&&Ykn(n,x,r).catch(SAn)");
  once(".then(()=>tKt({scope:n,accountId:g?.accountId,hostId:v,queryClient:r,shouldUseNewAppLifecycle:m}))", `.then(()=>{${BRIDGE}.ensure(__twAppsScope);return tKt({scope:n,accountId:g?.accountId,hostId:v,queryClient:r,shouldUseNewAppLifecycle:m,accountsCapture:__twAppsScope})})`);
  source = source.replace(/\br\.(getQueryData|setQueryData|invalidateQueries|cancelQueries|fetchQuery)\(/g, "__twQueries.$1(").replaceAll("queryClient:r", "queryClient:__twQueries").replaceAll("Ykn(n,x,r)", "Ykn(n,x,__twQueries)");
  source = source.replace(/\$l\.safe(Get|Post)\(/g, (_match, verb: string) => `${BRIDGE}.http($l,"safe${verb}",__twAppsScope)(`);
  const ast = parse(source, {ecmaVersion:"latest",sourceType:"module"}) as any;
  let callback: any;
  const find = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "AssignmentExpression" && node.left?.name === "u" && node.right?.type === "ArrowFunctionExpression" && node.right.async) callback = node.right;
    for (const [key,value] of Object.entries(node)) if (!["start","end"].includes(key)) {
      if (Array.isArray(value)) value.forEach(find); else if (value && typeof value === "object") find(value);
    }
  };
  find(ast);
  if (!callback) throw Error("Accounts OAuth callback boundary changed.");
  const awaits: any[] = [];
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "AwaitExpression") { awaits.push(node); return; }
    for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value); }
  };
  visit(callback.body);
  // Recursively guard nested awaits (including those inside an awaited mapper),
  // replacing ranges from right to left so vendor offsets remain exact.
  const render = (node: any): string => {
    const inner: any[] = []; const collect = (child: any): void => {
      if (!child || typeof child !== "object") return;
      if (child !== node && child.type === "AwaitExpression") { inner.push(child); return; }
      for (const value of Object.values(child)) { if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value === "object") collect(value); }
    }; collect(node);
    let value = source.slice(node.start,node.end);
    for (const child of inner.sort((a,b)=>b.start-a.start)) value = value.slice(0,child.start-node.start) + guarded(child) + value.slice(child.end-node.start);
    return value;
  };
  const guarded = (node: any): string => `(await ${BRIDGE}.awaitCaptured(__twAppsScope,async()=>(${render(node.argument)})))`;
  for (const node of awaits.sort((a,b)=>b.start-a.start)) source=source.slice(0,node.start)+guarded(node)+source.slice(node.end);
  return source;
}

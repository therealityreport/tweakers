import { createHash } from "node:crypto";
import { ACCOUNTS_NATIVE_9922_COMPANIONS, ACCOUNTS_NATIVE_REQUIRED_HOOKS, validateAccountsNativeCompatibility, type AccountsNativeCompatibilityRecordV1 } from "@therealityreport/tweakers-sdk";
import { nativeBootstrapSource, type AccountsNativePatchResult } from "./codex-accounts-native.js";
import { ACCOUNTS_NATIVE_MAIN_PATHS, patchAccountsNativeMainSources, validateAccountsNativeMainCarriers } from "./codex-accounts-native-9922-main.js";

export const ACCOUNTS_NATIVE_BUILD = "26.915.31945";
const MARKER = "__tweakers_accounts_native_v1__";
const BRIDGE = "globalThis.__tweakersAccountsNativeV1";
const PREFIX = "webview/assets/";
const DATA = "app-initial-a498f911edeb.js";
const UI = "app-primary-426732871368.js";
const APPS = "apps-availability-d00c1dea79ce.js";
const REVIEWED_ASSETS: Readonly<Record<string, readonly string[]>> = {
  [DATA]: ["34a75db63c7137eb4caecdba1f36d631c10c7912487e532fd5e9dafb175bb9be", "0077a0b6b27f03c9e47f1293c6db81dd58a3b45a7431af526af78c3f90939e9c"],
  [UI]: ["b22f199fd6c67bf54fedb460d2d7f918cccb7c1733c2573ea1df3fa345e7736f"],
  "profile-2366a81d3e2c.js": ["638f74bc346bbb3bad8278990a399730c9241cdd7f169d2b0920f4c06a9119a9"],
  "plugins-page-fbd9815f237a.js": ["f2c375422ef926c5164a8d0a0e9ac3e44b4949604bfe7eec9f07f2b34bf5fb8a"],
  "mcp-settings-6bad56fa4ad3.js": ["788da06fcabca977d47917b404193197a58795feb2b6ef3ab409b368e0af71db"],
  "local-conversation-thread-e308a5875678.js": ["bc6b8e733be43b5f385aad2ad83d0a9164f3a2cbd55287fbc564f5d2f51870e6"],
  [APPS]: ["4be90462c4490b5322d8005c87a6c9349422c390144f8ed16d126775dc12e97a"],
};
const digest = (source: string) => createHash("sha256").update(source).digest("hex");
const CARRIER_ANCHORS: Readonly<Record<string, string>> = {
  [DATA]: "AppServerRequestClient is missing a message dispatcher",
  [UI]: "You’re out of Codex and Work usage",
  "profile-2366a81d3e2c.js": "relative isolate flex flex-col items-center",
  "plugins-page-fbd9815f237a.js": "flex h-full min-h-0 flex-col",
  "mcp-settings-6bad56fa4ad3.js": "manageOnly:!0",
  "local-conversation-thread-e308a5875678.js": "children:[_,v,y,b,x,S,C,w]",
  [APPS]: "App setting is overridden by project configuration",
};

/** Every scoped carrier is authenticated before any replacement is returned. */
export function patchCodexAccountsNative9922Sources(sources: ReadonlyMap<string, string>, previousRecord?: unknown): AccountsNativePatchResult {
  const hooks = [...ACCOUNTS_NATIVE_REQUIRED_HOOKS];
  const hookSetSha256 = digest(JSON.stringify(hooks));
  const unavailable = (reason: string): AccountsNativePatchResult => ({ changed: false, sources: new Map(sources), record: { version: 1, bridgeVersion: 1, build: ACCOUNTS_NATIVE_BUILD, status: "unavailable", hooks, hookSetSha256, assets: [], reason } });
  // Authenticate official same-prefix companions without treating them as
  // modified receipt assets. Unknown siblings are never ignored.
  for (const [path, expected] of Object.entries(ACCOUNTS_NATIVE_9922_COMPANIONS)) {
    const source = sources.get(path);
    if (source === undefined || digest(source) !== expected) return unavailable("A reviewed Accounts companion is missing or changed: " + path);
  }
  for (const name of Object.keys(REVIEWED_ASSETS)) {
    const family = name.replace(/-[a-f0-9]+\.js$/, "-");
    const candidates = [...sources].filter(([path]) => new RegExp(`^${PREFIX}${family}[^/]+\\.js$`).test(path));
    for (const [path, source] of candidates) {
      if (path === PREFIX + name) continue;
      if (ACCOUNTS_NATIVE_9922_COMPANIONS[path] === digest(source)) continue;
      return unavailable("Accounts carrier inventory changed: " + path);
    }
    if (!candidates.some(([path]) => path === PREFIX + name)) return unavailable("A required Accounts carrier is missing.");
  }
  try { validateAccountsNativeMainCarriers(sources); } catch (error) { return unavailable((error as Error).message); }
  if ([...sources.values()].some(source => source.includes(MARKER))) {
    const status = validateAccountsNativeCompatibility(previousRecord, path => {
      const source = sources.get(path);
      if (source === undefined) throw new Error("missing asset");
      return source;
    }, digest);
    if (!status.compatible || status.build !== ACCOUNTS_NATIVE_BUILD) return unavailable(status.reason ?? "Accounts build changed.");
    return { changed: false, sources: new Map(sources), record: previousRecord as AccountsNativeCompatibilityRecordV1 };
  }
  for (const [name, hashes] of Object.entries(REVIEWED_ASSETS)) {
    const source = sources.get(PREFIX + name);
    if (source === undefined || !hashes.includes(digest(source))) return unavailable("This desktop's Accounts components have not been reviewed. Native behavior was preserved.");
    const family = name.replace(/-[a-f0-9]+\.js$/, "-");
    if ([...sources].filter(([path, source]) => new RegExp(`^${PREFIX}${family}[a-f0-9]+\\.js$`).test(path) && source.includes(CARRIER_ANCHORS[name])).length !== 1) return unavailable("More than one Accounts component matched this desktop build.");
  }
  const result = new Map(sources);
  const once = (source: string, anchor: string, replacement: string) => {
    if (source.split(anchor).length !== 2) throw new Error("Accounts native hook must match exactly once: " + anchor);
    return source.replace(anchor, () => replacement);
  };
  const edit = (name: string, anchor: string, replacement: string) => result.set(PREFIX + name, once(result.get(PREFIX + name)!, anchor, replacement));
  const region = (name: string, start: string, end: string, transform: (source: string) => string) => {
    const source = result.get(PREFIX + name)!;
    if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error("Accounts native flow boundaries changed: " + start);
    const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
    if (to < from) throw new Error("Accounts native flow order changed.");
    result.set(PREFIX + name, source.slice(0, from) + transform(source.slice(from, to)) + source.slice(to));
  };
  try {
    for (const [path, source] of patchAccountsNativeMainSources(sources, hookSetSha256)) result.set(path, source);
    edit(DATA, "defaultQueryOptions(e){if(e._defaulted)return e;", `defaultQueryOptions(e){e=${BRIDGE}.options(e);if(e._defaulted)return e;`);
    for (const anchor of ["getQueriesData(e){", "setQueriesData(e,t,n){", "removeQueries(e){", "resetQueries(e,t){", "cancelQueries(e,t={}){", "invalidateQueries(e,t={}){", "refetchQueries(e,t={}){"]) edit(DATA, anchor, `${anchor}e=${BRIDGE}.filter(e);`);
    edit(DATA, "function q_t(e,t,n,{cacheSubscriptions:r,getEnabledReaderOptions:i,getShouldSuppressStaleFetchOnEnable:a,isEnabledReaderMounting:o,shouldRetainFetchStartedAfterUnmount:s}){let c=id(0)", `function q_t(e,t,n,{cacheSubscriptions:r,getEnabledReaderOptions:i,getShouldSuppressStaleFetchOnEnable:a,isEnabledReaderMounting:o,shouldRetainFetchStartedAfterUnmount:s}){let __twAccountsEpoch=${BRIDGE}.signalEpoch(id);let c=id(0)`);
    edit(DATA, "i=U_t(n(t).defaultQueryOptions(e(t)))", `i=U_t(n(t).defaultQueryOptions(${BRIDGE}.signalOptions(e(t),t,__twAccountsEpoch)))`);
    edit(DATA, "let t=U_t(n(e).defaultQueryOptions(i(e)));return h(t),t", `let t=U_t(n(e).defaultQueryOptions(${BRIDGE}.signalOptions(i(e),e,__twAccountsEpoch)));return h(t),t`);
    edit(DATA, "async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);return e===`config/read`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===`plugin/list`&&n?.timeoutMs==null?{...n,timeoutMs:Den}:n)}", `async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(\`AppServerRequestClient is missing a message dispatcher\`);return ${BRIDGE}.rpc(e,t,()=>e===\`config/read\`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===\`plugin/list\`&&n?.timeoutMs==null?{...n,timeoutMs:Den}:n))}`);
    edit(DATA, "a=JSON.stringify({options:i,params:n}),o=t.get(a)", `a=JSON.stringify({options:i,params:n,accountsScope:${BRIDGE}.key("mcp")}),o=t.get(a)`);
    edit("plugins-page-fbd9815f237a.js", "At(i,p)", 'At(i,{...p,accountsNativeSurface:"mcp"})');
    region(DATA, "function kun(e,t){", "function Aun(e){", source => once(source, "Jf(p)}", `Jf(${BRIDGE}.configOptions(t?.accountsNativeSurface,p,false,c))}`));
    // Explicit capture is threaded through the shared helper only by scoped callers.
    edit(DATA, "async function qun(e,t,n){let{layers:r}=await bb(e,t,n,null,!0);return Jun(r)}", `async function qun(e,t,n,__twCaptured){let{layers:r}=await ${BRIDGE}.configRead(__twCaptured,()=>bb(e,t,n,null,!0));return Jun(r)}`);
    edit(APPS, "x=async e=>{let{appId:t,enabled:n}=e,a=await d(i,l,r);if((await _(i,r).sendRequest(`config/batchWrite`,{edits:L({appId:t,enabled:n}),filePath:a?.filePath??null,expectedVersion:a?.expectedVersion??null,reloadUserConfig:!0})).status===`okOverridden`)", `x=async e=>{let __twCaptured=${BRIDGE}.mutationScope("apps",e);let{appId:t,enabled:n}=e,a=await d(i,l,r,__twCaptured);if((await ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:L({appId:t,enabled:n}),filePath:a?.filePath??null,expectedVersion:a?.expectedVersion??null,reloadUserConfig:!0},()=>_(i,r).sendRequest(\`config/batchWrite\`,{edits:L({appId:t,enabled:n}),filePath:a?.filePath??null,expectedVersion:a?.expectedVersion??null,reloadUserConfig:!0}))).status===\`okOverridden\`)`);
    edit(APPS, "let P=p(N)", `let P=${BRIDGE}.mutationHandle("apps",p(${BRIDGE}.mutation("apps",N)))`);
    edit(APPS, "await l.cancelQueries({queryKey:v});let r=", `await l.cancelQueries({queryKey:v});${BRIDGE}.mutationScope("apps",e);let r=`);
    edit(APPS, "(await u(v),l.getQueryData(v)", `(await u(v),${BRIDGE}.mutationScope("apps",t),l.getQueryData(v)`);
    region(DATA, "function Vun(e){", "function Hun(e,t){", source => {
      source = once(source, "u=e=>{let{key:t,enabled:i}=e;return ep(n,r).sendRequest(`config/value/write`,{keyPath:`mcp_servers.${t}.enabled`,value:i,mergeStrategy:`upsert`,filePath:null,expectedVersion:null})}", `u=e=>{let __twCaptured=${BRIDGE}.mutationScope("mcp",e);let{key:t,enabled:i}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"config/value/write",{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:"upsert",filePath:null,expectedVersion:null},()=>ep(n,r).sendRequest(\`config/value/write\`,{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:"upsert",filePath:null,expectedVersion:null}))}`);
      source = once(source, "await Promise.all([i.cancelQueries({queryKey:s}),i.cancelQueries({queryKey:l})]);let r=", `await Promise.all([i.cancelQueries({queryKey:s}),i.cancelQueries({queryKey:l})]);${BRIDGE}.mutationScope("mcp",e);let r=`);
      source = source.replaceAll("queryKey:l", `queryKey:${BRIDGE}.scopedKey("mcp",l)`);
      source = once(source, "Hun(i,l)", `Hun(i,${BRIDGE}.scopedKey("mcp",l))`);
      source = once(source, "a([...wb,r])", `a(${BRIDGE}.scopedKey("mcp",[...wb,r]))`);
      source = once(source, ",Zf(h)}", `,${BRIDGE}.mutationHandle("mcp",Zf(${BRIDGE}.mutation("mcp",h)))}`);
      return source;
    });
    edit(DATA, "let e=await oy.safeGet(`/wham/profiles/me`)", `let __twNativeProfile=await oy.safeGet(\`/wham/profiles/me\`);let e=await ${BRIDGE}.request("profile","profile.statistics",{native:__twNativeProfile},()=>__twNativeProfile)`);
    edit(DATA, 'let n=await oy.safeGet(`/wham/usage`,{additionalHeaders:{"OAI-App-Brand":Qv.toLowerCase(),...e},signal:t})', `let n=await ${BRIDGE}.usage(await oy.safeGet(\`/wham/usage\`,{additionalHeaders:{"OAI-App-Brand":Qv.toLowerCase(),...e},signal:t}))`);
    edit(DATA, "function gSi(){return oy.safeGet(`/wham/rate-limit-reset-credits`)}", `function gSi(){return ${BRIDGE}.request("usage","usage.credits.read",{},()=>oy.safeGet(\`/wham/rate-limit-reset-credits\`))}`);
    region(DATA, "function _Si(){", "function vSi(e){", source => once(source, "Zf(r)}", `${BRIDGE}.mutationHandle("usage",Zf(${BRIDGE}.mutation("usage",r)))}`));
    edit(DATA, "function vSi(e){let{creditId:t,redeemRequestId:n}=e;return oy.safePost(`/wham/rate-limit-reset-credits/consume`,{requestBody:{credit_id:t,redeem_request_id:n}})}", `function vSi(e){let __twCaptured=${BRIDGE}.mutationScope("usage",e);let{creditId:t,redeemRequestId:n}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"usage.credits.consume",{creditId:t,redeemRequestId:n},()=>oy.safePost(\`/wham/rate-limit-reset-credits/consume\`,{requestBody:{credit_id:t,redeem_request_id:n}}))}`);
    region(DATA, "async function MHn(", "async function NHn(", source => {
      source = once(source, "{let m=vHn(t.id,n)", `{let __twAppsScope=${BRIDGE}.capture("apps");if(__twAppsScope&&f!=null)return{kind:"failed"};let m=vHn(t.id,n)`);
      source = once(source, "u.fetchQuery(lw(t.id,{productSku:m?.productSku}))", `u.fetchQuery(${BRIDGE}.scopedQuery(lw(t.id,{productSku:m?.productSku}),__twAppsScope))`);
      source = source.replaceAll("catch(r){return $t.error", 'catch(r){if(__twAppsScope)return{kind:"failed"};return $t.error');
      source = once(source, "if(VHn(g)||_===`UNSUPPORTED`)return XHn", 'if(VHn(g)||_===`UNSUPPORTED`)return __twAppsScope?{kind:"failed"}:XHn');
      return source.replaceAll("oy.safePost(", `${BRIDGE}.http(oy,"safePost",__twAppsScope)(`);
    });
    region(DATA, "async function PHn(", "function FHn(", source => {
      source = once(source, "{if(r===`missing_link`)", `{let __twAppsScope=${BRIDGE}.capture("apps");if(r===\`missing_link\`)`);
      source = once(source, "catch(e){$t.error", 'catch(e){if(__twAppsScope)return{kind:"failed"};$t.error');
      source = once(source, "if(!e)return{kind:`failed`}", 'if(!e||__twAppsScope)return{kind:`failed`}');
      return source.replaceAll("oy.safePost(", `${BRIDGE}.http(oy,"safePost",__twAppsScope)(`);
    });
    edit(DATA, "if(O=!0,C())return{kind:`missing-callback-data`}", `if(O=!0,!${BRIDGE}.oauthResultCurrent(e)){S!=null&&f9(n,S);o({oauthState:x});E!=null&&Vul.delete(E);return{kind:"success",appId:e.link.connector_id,appName:e.link?.name?.trim()||_?.appName||"App"}}if(C())return{kind:\`missing-callback-data\`}`);
    // Shared Plugins stay native, including their separate lazy installation module.
    result.set(PREFIX + DATA, result.get(PREFIX + DATA)!.replace(/oy\.safe(Get|Post)\(/g, (_match, verb: string) => `${BRIDGE}.http(oy,"safe${verb}")(`));
    edit(DATA, "usageItems:Vt})", `usageItems:${BRIDGE}.render("account-menu",Vt,{jsx:d6.jsx,react:F6s})})`);
    edit(DATA, "usageWindows:f}=e,p=i!==void 0&&i", `usageWindows:__twNativeWindows}=e,f=${BRIDGE}.project("usage","windows",__twNativeWindows),p=i!==void 0&&i`);
    edit(DATA, "children:[xe,De,Oe,ke]", `children:[xe,${BRIDGE}.render("usage",null,{jsx:B0.jsx,react:z0}),De,Oe,ke]`);
    for (const original of ["You’re out of Codex and Work usage", "You’ve used all Codex and Work usage", "You’ve reached your usage limit"]) edit(UI, `defaultMessage:\`${original}\``, `defaultMessage:${BRIDGE}.project("usage","depleted-message",${JSON.stringify(original)})`);
    edit("profile-2366a81d3e2c.js", "className:`relative isolate flex flex-col items-center`,children:Qn", `className:\`relative isolate flex flex-col items-center\`,children:[Qn,${BRIDGE}.render("profile",null,{jsx:$.jsx,react:wd})]`);
    edit("plugins-page-fbd9815f237a.js", "className:`flex h-full min-h-0 flex-col`,children:[Tl,El,Ol]", `className:\`flex h-full min-h-0 flex-col\`,children:[Tl,${BRIDGE}.render("plugins",null,{jsx:$.jsx,react:Q}),${BRIDGE}.render("apps",null,{jsx:$.jsx,react:Q}),El,Ol]`);
    edit("mcp-settings-6bad56fa4ad3.js", "children:(0,p.jsx)(u,{manageOnly:!0})", `children:[${BRIDGE}.render("mcp",null,{jsx:p.jsx,react:${BRIDGE}.react()}),(0,p.jsx)(u,{manageOnly:!0})]`);
    edit("local-conversation-thread-e308a5875678.js", "children:[_,v,y,b,x,S,C,w]", `children:[_,v,y,b,x,${BRIDGE}.render("thread-summary",null,{jsx:XT.jsx,react:et()}),S,C,w]`);
    result.set(PREFIX + DATA, nativeBootstrapSource(hookSetSha256) + "\n" + result.get(PREFIX + DATA));
    for (const name of Object.keys(REVIEWED_ASSETS).filter(name => name !== DATA)) result.set(PREFIX + name, `/*${MARKER}*/\n` + result.get(PREFIX + name));
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Accounts native anchors changed.");
  }
  const assets = [...Object.keys(REVIEWED_ASSETS).map(name => PREFIX + name), ...ACCOUNTS_NATIVE_MAIN_PATHS].map(path => ({ path, sha256: digest(result.get(path)!) }));
  return { changed: true, sources: result, record: { version: 1, bridgeVersion: 1, build: ACCOUNTS_NATIVE_BUILD, status: "compatible", hooks, hookSetSha256, assets } };
}

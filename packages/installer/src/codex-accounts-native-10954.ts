import { createHash } from "node:crypto";
import { ACCOUNTS_NATIVE_10954_COMPANIONS, ACCOUNTS_NATIVE_REQUIRED_HOOKS, validateAccountsNativeCompatibility, type AccountsNativeCompatibilityRecordV1 } from "@therealityreport/tweakers-sdk";
import { nativeBootstrapSource, type AccountsNativePatchResult } from "./codex-accounts-native.js";
import { ACCOUNTS_NATIVE_10954_MAIN_PATH, ACCOUNTS_NATIVE_10954_SHARED_PATH, patchAccountsNative10954MainSources, validateAccountsNative10954MainCarriers } from "./codex-accounts-native-10954-main.js";

const MARKER = "__tweakers_accounts_native_v1__";
const BRIDGE = "globalThis.__tweakersAccountsNativeV1";
const PREFIX = "webview/assets/";
const ACCOUNTS_NATIVE_BUILD = "26.917.71314";
const DATA = "app-initial-51da50e6c6e3.js";
const SHARED = "app-shared-7b9edc1bfb7f.js";
const UI = "app-primary-d66705000d76.js";
const APPS = "apps-availability-550a32a13cbe.js";
const PROFILE = "profile-2f0975511066.js";
const PLUGINS = "plugins-page-fe136f0c8463.js";
const MCP = "mcp-settings-46098748ccb7.js";
const THREAD = "local-conversation-thread-c6e40fdd6d59.js";
// Pristine native bytes; app-initial also accepts the bytes left by the installer's earlier
// model-selection and inactive-thread-retention renderer patches.
const REVIEWED_ASSETS: Readonly<Record<string, readonly string[]>> = {
  [DATA]: ["ea4b3893669a56e67f6baa7d2791ed64e954b081a549f62b647101def36ef6d1", "00829e3c331984c38fff25e2294f3fa1a03f87eff33b4f702b7d427dfb260ff8"],
  [SHARED]: ["c387f54128835461f0c44dacf94dfa5404a7850a34508188c85f9c43762118eb"],
  [UI]: ["95e007f69d9f2541e5a4fd9d0c3cddcde2793652178d4026fe0cf49893f8b90c"],
  [APPS]: ["77e22b6b781264afb2c086085e215dfa49aaddacf1fa8ed001e6e89377c90cdb"],
  [PROFILE]: ["f3db94331fadf594de61e59164b517f910c396766f890c4f2e86cf22d9adafc6"],
  [PLUGINS]: ["89691502e7ab9be3fd6160f92b07b68882f19cd391ed261d2fefb9e99a2972c6"],
  [MCP]: ["207e0e32f23af1f9429d5086398b0521d744074ad3b7691ac8f6d8ab0722ebb1"],
  [THREAD]: ["930d09dff466ac33657f5b04b8bc3b937d48c81fa13db1993c625dd68138862e"],
};
const COMPANIONS: Readonly<Record<string, string>> = ACCOUNTS_NATIVE_10954_COMPANIONS;
const CARRIER_ANCHORS: Readonly<Record<string, string>> = {
  [DATA]: "AppServerRequestClient is missing a message dispatcher", [SHARED]: "defaultQueryOptions(e){",
  [UI]: "You’re out of Codex and Work usage", [PROFILE]: "relative isolate flex flex-col items-center",
  [PLUGINS]: "flex h-full min-h-0 flex-col", [MCP]: "manageOnly:!0",
  [THREAD]: "children:[S,C,w,T,E,D,O,k]", [APPS]: "App setting is overridden by project configuration",
};
const digest = (source: string) => createHash("sha256").update(source).digest("hex");

/**
 * Reviewed 10954 recipe. Every hook is the 10492/10640 hook re-located by
 * semantic equivalence; only minified local names differ. Every scoped carrier
 * is authenticated before any replacement is returned.
 */
export function patchCodexAccountsNative10954Sources(sources: ReadonlyMap<string, string>, previousRecord?: unknown): AccountsNativePatchResult {
  const hooks = [...ACCOUNTS_NATIVE_REQUIRED_HOOKS];
  const hookSetSha256 = digest(JSON.stringify(hooks));
  const unavailable = (reason: string): AccountsNativePatchResult => ({ changed: false, sources: new Map(sources), record: { version: 1, bridgeVersion: 1, build: ACCOUNTS_NATIVE_BUILD, status: "unavailable", hooks, hookSetSha256, assets: [], reason } });
  // Authenticate official same-prefix companions without treating them as
  // modified receipt assets. Unknown siblings are never ignored.
  for (const [path, expected] of Object.entries(COMPANIONS)) {
    const source = sources.get(path);
    if (source === undefined || digest(source) !== expected) return unavailable("A reviewed Accounts companion is missing or changed: " + path);
  }
  for (const name of Object.keys(REVIEWED_ASSETS)) {
    const family = name.replace(/-[a-f0-9]+\.js$/, "-");
    const candidates = [...sources].filter(([path]) => new RegExp(`^${PREFIX}${family}[^/]+\\.js$`).test(path));
    for (const [path, source] of candidates) {
      if (path === PREFIX + name) continue;
      if (COMPANIONS[path] === digest(source)) continue;
      return unavailable("Accounts carrier inventory changed: " + path);
    }
    if (!candidates.some(([path]) => path === PREFIX + name)) return unavailable("A required Accounts carrier is missing.");
  }
  try { validateAccountsNative10954MainCarriers(sources); } catch (error) { return unavailable((error as Error).message); }
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
    for (const [path, source] of patchAccountsNative10954MainSources(sources, hookSetSha256)) result.set(path, source);
    edit(SHARED, "defaultQueryOptions(e){if(e._defaulted)return e;", `defaultQueryOptions(e){e=${BRIDGE}.options(e);if(e._defaulted)return e;`);
    for (const anchor of ["getQueriesData(e){", "setQueriesData(e,t,n){", "removeQueries(e){", "resetQueries(e,t){", "cancelQueries(e,t={}){", "invalidateQueries(e,t={}){", "refetchQueries(e,t={}){"]) edit(SHARED, anchor, `${anchor}e=${BRIDGE}.filter(e);`);
    edit(SHARED, "function Nje(e,t,n,{cacheSubscriptions:r,getEnabledReaderOptions:i,getShouldSuppressStaleFetchOnEnable:a,isEnabledReaderMounting:o,shouldRetainFetchStartedAfterUnmount:s}){let c=KN(0)", `function Nje(e,t,n,{cacheSubscriptions:r,getEnabledReaderOptions:i,getShouldSuppressStaleFetchOnEnable:a,isEnabledReaderMounting:o,shouldRetainFetchStartedAfterUnmount:s}){let __twAccountsEpoch=${BRIDGE}.signalEpoch(KN);let c=KN(0)`);
    edit(SHARED, "i=Aje(n(t).defaultQueryOptions(e(t)))", `i=Aje(n(t).defaultQueryOptions(${BRIDGE}.signalOptions(e(t),t,__twAccountsEpoch)))`);
    edit(SHARED, "let t=Aje(n(e).defaultQueryOptions(i(e)));return h(t),t", `let t=Aje(n(e).defaultQueryOptions(${BRIDGE}.signalOptions(i(e),e,__twAccountsEpoch)));return h(t),t`);
    edit(DATA, "async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);return e===`config/read`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===`plugin/list`&&n?.timeoutMs==null?{...n,timeoutMs:Cjt}:n)}", `async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(\`AppServerRequestClient is missing a message dispatcher\`);return ${BRIDGE}.rpc(e,t,()=>e===\`config/read\`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===\`plugin/list\`&&n?.timeoutMs==null?{...n,timeoutMs:Cjt}:n))}`);
    edit(DATA, "a=JSON.stringify({options:i,params:n}),o=t.get(a)", `a=JSON.stringify({options:i,params:n,accountsScope:${BRIDGE}.key("mcp")}),o=t.get(a)`);
    // PLUGINS imports the MCP servers config hook (DATA fUt) as Er.
    edit(PLUGINS, "Er(r,m)", 'Er(r,{...m,accountsNativeSurface:"mcp"})');
    region(DATA, "function fUt(e,t){", "function pUt(e){", source => once(source, "Zi(p)}", `Zi(${BRIDGE}.configOptions(t?.accountsNativeSurface,p,false,c))}`));
    // Explicit capture is threaded through the shared helper only by scoped callers.
    edit(DATA, "async function AUt(e,t,n){let{layers:r}=await Ov(e,t,n,null,!0);return jUt(r)}", `async function AUt(e,t,n,__twCaptured){let{layers:r}=await ${BRIDGE}.configRead(__twCaptured,()=>Ov(e,t,n,null,!0));return jUt(r)}`);
    edit(APPS, "b=async e=>{let{appId:t,enabled:n}=e,a=await D(i,l,r);if((await O(i,r).sendRequest(`config/batchWrite`,{edits:L({appId:t,enabled:n}),filePath:a?.filePath??null,expectedVersion:a?.expectedVersion??null,reloadUserConfig:!0})).status===`okOverridden`)", `b=async e=>{let __twCaptured=${BRIDGE}.mutationScope("apps",e);let{appId:t,enabled:n}=e,a=await D(i,l,r,__twCaptured);if((await ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:L({appId:t,enabled:n}),filePath:a?.filePath??null,expectedVersion:a?.expectedVersion??null,reloadUserConfig:!0},()=>O(i,r).sendRequest(\`config/batchWrite\`,{edits:L({appId:t,enabled:n}),filePath:a?.filePath??null,expectedVersion:a?.expectedVersion??null,reloadUserConfig:!0}))).status===\`okOverridden\`)`);
    edit(APPS, "let P=p(M)", `let P=${BRIDGE}.mutationHandle("apps",p(${BRIDGE}.mutation("apps",M)))`);
    edit(APPS, "await l.cancelQueries({queryKey:_});let r=", `await l.cancelQueries({queryKey:_});${BRIDGE}.mutationScope("apps",e);let r=`);
    edit(APPS, "(await u(_),l.getQueryData(_)", `(await u(_),${BRIDGE}.mutationScope("apps",t),l.getQueryData(_)`);
    region(DATA, "function wUt(e){", "function TUt(e,t){", source => {
      source = once(source, "u=e=>{let{key:t,enabled:i}=e;return jd(n,r).sendRequest(`config/value/write`,{keyPath:`mcp_servers.${t}.enabled`,value:i,mergeStrategy:`upsert`,filePath:null,expectedVersion:null})}", `u=e=>{let __twCaptured=${BRIDGE}.mutationScope("mcp",e);let{key:t,enabled:i}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"config/value/write",{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:"upsert",filePath:null,expectedVersion:null},()=>jd(n,r).sendRequest(\`config/value/write\`,{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:"upsert",filePath:null,expectedVersion:null}))}`);
      source = once(source, "await Promise.all([i.cancelQueries({queryKey:s}),i.cancelQueries({queryKey:l})]);let r=", `await Promise.all([i.cancelQueries({queryKey:s}),i.cancelQueries({queryKey:l})]);${BRIDGE}.mutationScope("mcp",e);let r=`);
      source = source.replaceAll("queryKey:l", `queryKey:${BRIDGE}.scopedKey("mcp",l)`);
      source = once(source, "TUt(i,l)", `TUt(i,${BRIDGE}.scopedKey("mcp",l))`);
      source = once(source, "a([...Mv,r])", `a(${BRIDGE}.scopedKey("mcp",[...Mv,r]))`);
      source = once(source, ",Ya(h)}", `,${BRIDGE}.mutationHandle("mcp",Ya(${BRIDGE}.mutation("mcp",h)))}`);
      return source;
    });
    edit(DATA, "let e=await kg.safeGet(`/wham/profiles/me`)", `let __twNativeProfile=await kg.safeGet(\`/wham/profiles/me\`);let e=await ${BRIDGE}.request("profile","profile.statistics",{native:__twNativeProfile},()=>__twNativeProfile)`);
    edit(DATA, "GOn=va(X,`polling`,", `__twAccountsUsageEpoch=va(X,0,({set:t})=>{let n=0;return ${BRIDGE}.subscribe("usage",()=>t(++n))}),GOn=va(X,\`polling\`,`);
    edit(DATA, "KOn=ls(X,({get:e})=>{let t=e(GOn),n=e(mzt),r=e(qg);", `KOn=ls(X,({get:e})=>{e(__twAccountsUsageEpoch);let t=${BRIDGE}.key("usage")==="native"?e(GOn):"polling",n=e(mzt),r=e(qg);`);
    edit(DATA, 'return NOn(await kg.safeGet(`/wham/usage`,{additionalHeaders:{"OAI-App-Brand":mg.toLowerCase(),...e},signal:t}))', `return ${BRIDGE}.usage(NOn(await kg.safeGet(\`/wham/usage\`,{additionalHeaders:{"OAI-App-Brand":mg.toLowerCase(),...e},signal:t})))`);
    edit(DATA, "function Eai(){return kg.safeGet(`/wham/rate-limit-reset-credits`)}", `function Eai(){return ${BRIDGE}.request("usage","usage.credits.read",{},()=>kg.safeGet(\`/wham/rate-limit-reset-credits\`))}`);
    region(DATA, "function Dai(){", "function Oai(e){", source => once(source, "Ya(r)}", `${BRIDGE}.mutationHandle("usage",Ya(${BRIDGE}.mutation("usage",r)))}`));
    edit(DATA, "function Oai(e){let{creditId:t,redeemRequestId:n}=e;return kg.safePost(`/wham/rate-limit-reset-credits/consume`,{requestBody:{credit_id:t,redeem_request_id:n}})}", `function Oai(e){let __twCaptured=${BRIDGE}.mutationScope("usage",e);let{creditId:t,redeemRequestId:n}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"usage.credits.consume",{creditId:t,redeemRequestId:n},()=>kg.safePost(\`/wham/rate-limit-reset-credits/consume\`,{requestBody:{credit_id:t,redeem_request_id:n}}))}`);
    region(DATA, "async function Tyn(", "async function Eyn(", source => {
      source = once(source, "{let m=dyn(t.id,n)", `{let __twAppsScope=${BRIDGE}.capture("apps");if(__twAppsScope&&f!=null)return{kind:"failed"};let m=dyn(t.id,n)`);
      source = once(source, "u.fetchQuery(iC(t.id,{productSku:m?.productSku}))", `u.fetchQuery(${BRIDGE}.scopedQuery(iC(t.id,{productSku:m?.productSku}),__twAppsScope))`);
      source = source.replaceAll("catch(r){return Zr.error", 'catch(r){if(__twAppsScope)return{kind:"failed"};return Zr.error');
      source = once(source, "if(Pyn(g)||_===`UNSUPPORTED`)return Uyn", 'if(Pyn(g)||_===`UNSUPPORTED`)return __twAppsScope?{kind:"failed"}:Uyn');
      return source.replaceAll("kg.safePost(", `${BRIDGE}.http(kg,"safePost",__twAppsScope)(`);
    });
    region(DATA, "async function Dyn(", "function Oyn(", source => {
      source = once(source, "{if(r===`missing_link`)", `{let __twAppsScope=${BRIDGE}.capture("apps");if(r===\`missing_link\`)`);
      source = once(source, "catch(e){Zr.error", 'catch(e){if(__twAppsScope)return{kind:"failed"};Zr.error');
      source = once(source, "if(!e)return{kind:`failed`}", 'if(!e||__twAppsScope)return{kind:`failed`}');
      return source.replaceAll("kg.safePost(", `${BRIDGE}.http(kg,"safePost",__twAppsScope)(`);
    });
    // The pending connect record is `g` in 10954 (native success derives appName from g?.appName).
    edit(DATA, "if(O=!0,C())return{kind:`missing-callback-data`}", `if(O=!0,!${BRIDGE}.oauthResultCurrent(e)){S!=null&&i9(n,S);o({oauthState:x});E!=null&&qjc.delete(E);return{kind:"success",appId:e.link.connector_id,appName:e.link?.name?.trim()||g?.appName||"App"}}if(C())return{kind:\`missing-callback-data\`}`);
    // Shared Plugins stay native, including their separate lazy installation module.
    result.set(PREFIX + DATA, result.get(PREFIX + DATA)!.replace(/kg\.safe(Get|Post)\(/g, (_match, verb: string) => `${BRIDGE}.http(kg,"safe${verb}")(`));
    edit(DATA, "usageItems:Ht})", `usageItems:${BRIDGE}.render("account-menu",Ht,{jsx:P4.jsx,react:Z()})})`);
    edit(DATA, "usageWindows:f}=e,p=i!==void 0&&i", `usageWindows:__twNativeWindows}=e,f=${BRIDGE}.project("usage","windows",__twNativeWindows),p=i!==void 0&&i`);
    edit(DATA, "children:[Se,Oe,ke,Ae]", `children:[Se,${BRIDGE}.render("usage",null,{jsx:W$.jsx,react:U$}),Oe,ke,Ae]`);
    for (const original of ["You’re out of Codex and Work usage", "You’ve used all Codex and Work usage", "You’ve reached your usage limit"]) edit(UI, `defaultMessage:\`${original}\``, `defaultMessage:${BRIDGE}.project("usage","depleted-message",${JSON.stringify(original)})`);
    edit(PROFILE, "className:`relative isolate flex flex-col items-center`,children:[Xn,Zn]", `className:\`relative isolate flex flex-col items-center\`,children:[[Xn,Zn],${BRIDGE}.render("profile",null,{jsx:$.jsx,react:Hd})]`);
    edit(PLUGINS, "className:`flex h-full min-h-0 flex-col`,children:[Tl,El,Ol]", `className:\`flex h-full min-h-0 flex-col\`,children:[Tl,${BRIDGE}.render("plugins",null,{jsx:$.jsx,react:Q}),${BRIDGE}.render("apps",null,{jsx:$.jsx,react:Q}),El,Ol]`);
    // This lazy carrier does not pass through a query hook that captures React.
    // Import the authenticated shared getter explicitly so the Accounts slot mounts.
    result.set(PREFIX + MCP, `import{e6 as __twAccountsReact}from"./${SHARED}";\n` + result.get(PREFIX + MCP));
    edit(MCP, "children:(0,p.jsx)(u,{manageOnly:!0})", `children:[${BRIDGE}.render("mcp",null,{jsx:p.jsx,react:__twAccountsReact()}),(0,p.jsx)(u,{manageOnly:!0})]`);
    edit(THREAD, "children:[S,C,w,T,E,D,O,k]", `children:[S,C,w,T,E,${BRIDGE}.render("thread-summary",null,{jsx:DE.jsx,react:ft()}),D,O,k]`);
    result.set(PREFIX + DATA, "var __twAccountsUsageEpoch;\n" + result.get(PREFIX + DATA));
    result.set(PREFIX + SHARED, nativeBootstrapSource(hookSetSha256) + "\n" + result.get(PREFIX + SHARED));
    for (const name of Object.keys(REVIEWED_ASSETS).filter(name => name !== SHARED)) result.set(PREFIX + name, `/*${MARKER}*/\n` + result.get(PREFIX + name));
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Accounts native anchors changed.");
  }
  const assets = [...Object.keys(REVIEWED_ASSETS).map(name => PREFIX + name), ACCOUNTS_NATIVE_10954_MAIN_PATH, ACCOUNTS_NATIVE_10954_SHARED_PATH].map(path => ({ path, sha256: digest(result.get(path)!) }));
  return { changed: true, sources: result, record: { version: 1, bridgeVersion: 1, build: ACCOUNTS_NATIVE_BUILD, status: "compatible", hooks, hookSetSha256, assets } };
}

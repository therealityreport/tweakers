import { createHash } from "node:crypto";
import { ACCOUNTS_NATIVE_10492_COMPANIONS, ACCOUNTS_NATIVE_10640_COMPANIONS, ACCOUNTS_NATIVE_REQUIRED_HOOKS, validateAccountsNativeCompatibility, type AccountsNativeCompatibilityRecordV1 } from "@therealityreport/tweakers-sdk";
import { nativeBootstrapSource, type AccountsNativePatchResult } from "./codex-accounts-native.js";
import { ACCOUNTS_NATIVE_SHARED_PATH, patchAccountsNativeMainSources, validateAccountsNativeMainCarriers } from "./codex-accounts-native-10492-main.js";

const MARKER = "__tweakers_accounts_native_v1__";
const BRIDGE = "globalThis.__tweakersAccountsNativeV1";
const PREFIX = "webview/assets/";
const PROFILES = {
  "10492": {
    "build": "26.917.51856",
    "names": {
      "DATA": "app-initial-512cdcfeac48.js",
      "SHARED": "app-shared-962598dd111a.js",
      "UI": "app-primary-aaee46b7f0ce.js",
      "APPS": "apps-availability-1c16c509bc8d.js",
      "PROFILE": "profile-de305ab24861.js",
      "PLUGINS": "plugins-page-18eaa237cd5a.js",
      "MCP": "mcp-settings-bfb9ac8ef6e6.js",
      "THREAD": "local-conversation-thread-e0c4b5e613f5.js"
    },
    "reviewed": {
      "app-initial-512cdcfeac48.js": [
        "2f085c41d162a76a4820ee3fa4266b0effd9d8ebccb92731aab4283d1818bb01",
        "3facc441addaeaa4ca010099b5cc69363c76f11bfe6689ad8bd995ee3f1f8f1e"
      ],
      "app-shared-962598dd111a.js": [
        "dfbf17fc9841f6d2e11fc4a479ab57c46be69a9de3108a91b0ff98e6f8b0f2c8"
      ],
      "app-primary-aaee46b7f0ce.js": [
        "67681826dc2fbd8c7cf8171115c97159301b44f4f79b01463f399a02ae081e7a"
      ],
      "apps-availability-1c16c509bc8d.js": [
        "b3d33e1af5c729e183391c096211363bf05a6c33f802fc16a57450c20c780f55"
      ],
      "profile-de305ab24861.js": [
        "aead07d8da344b7748c0051d5fdedf840b9d8b1862dc289a94139dc856fabfc1"
      ],
      "plugins-page-18eaa237cd5a.js": [
        "85eb6601510b2ea9eb94bf8f1ae61fde38bdd045077c801c79adbf7583a6ec9c"
      ],
      "mcp-settings-bfb9ac8ef6e6.js": [
        "35215aca9ee9dd3aec220a0c7912fe7fbc77ddc15301fbdfe2606cb437be40d3"
      ],
      "local-conversation-thread-e0c4b5e613f5.js": [
        "920547cc3398e069a5ebe417f02a49db897a96ae8b12ad2f5230328f5b02a421"
      ]
    },
    "main": {
      "mainPath": ".vite/build/main-9ZiZs9Y1.js",
      "mainHashes": [
        "6f6072ec90510889f99f0679606a641db582dbe6dc6a2a5a0787c870be02a13d",
        "a2cc17ff38d14a5404b676a2b7aa69cca5f9470950537daf3bc271ba497f625f"
      ],
      "projectWriteHelper": "c2"
    }
  },
  "10640": {
    "build": "26.917.61114",
    "names": {
      "DATA": "app-initial-e1f6333a805b.js",
      "SHARED": "app-shared-6d89d53e1c60.js",
      "UI": "app-primary-62505c378fd0.js",
      "APPS": "apps-availability-7bc9ac958c49.js",
      "PROFILE": "profile-455ba0fb6d88.js",
      "PLUGINS": "plugins-page-26b63ab0f126.js",
      "MCP": "mcp-settings-30afd02b513b.js",
      "THREAD": "local-conversation-thread-2b5fe01b0e08.js"
    },
    "reviewed": {
      "app-initial-e1f6333a805b.js": [
        "854cf0baa598d1050d48a205c29022aa4b19749af10f4e3bb87bdbb38450d8bb",
        "4fd812dc38ac19063934e25b4b439a6e31240124205d626cf3638f4025e3a931"
      ],
      "app-shared-6d89d53e1c60.js": [
        "40576c476b3d0313cd85e80510d3043887c88f67ece7fad9ed1df8d6fe3285fc"
      ],
      "app-primary-62505c378fd0.js": [
        "8f4c66356c462e745aa2b188f38641262fc0e96b072029e331a338eaba399176"
      ],
      "apps-availability-7bc9ac958c49.js": [
        "384dd7e7f54bc12997312af78a2cb4ce06268ed34adf093400842bbacc35fd6a"
      ],
      "profile-455ba0fb6d88.js": [
        "b29d5e102840e353f8315efef9f866cdaeda78074fca2c3dfb12f046c681ba30"
      ],
      "plugins-page-26b63ab0f126.js": [
        "e44eba8f2f2f9e953f190de28161d6ff1ad0505335c03c843f76826dcff931ca"
      ],
      "mcp-settings-30afd02b513b.js": [
        "1551b46d3fa69edd38e23536b105b656ce1656d4539fd8ecea1bef0a0e06fc02"
      ],
      "local-conversation-thread-2b5fe01b0e08.js": [
        "31537485fd37dd58d0c17567bc5c0904fb22a63ffd6ffab91abafd199a12b004"
      ]
    },
    "main": {
      "mainPath": ".vite/build/main-DOn0I1A9.js",
      "mainHashes": [
        "2e300508312972be3d0bb7f02bf48fbeac93d6888943400a2db75bb8c54650e4",
        "99ffa3d7f5bf87f47bba90ad6e2bcf62534aa4df97e91e1e8c008739ce5cdc56"
      ],
      "projectWriteHelper": "s2"
    }
  }
} as const;
const digest = (source: string) => createHash("sha256").update(source).digest("hex");

/** Every scoped carrier is authenticated before any replacement is returned. */
export function patchCodexAccountsNative10492Sources(sources: ReadonlyMap<string, string>, previousRecord?: unknown): AccountsNativePatchResult {
  const profile = sources.has(PREFIX + PROFILES["10640"].names.DATA) ? PROFILES["10640"] : PROFILES["10492"];
  const {DATA, SHARED, UI, APPS, PROFILE, PLUGINS, MCP, THREAD} = profile.names;
  const ACCOUNTS_NATIVE_BUILD = profile.build;
  const REVIEWED_ASSETS: Readonly<Record<string, readonly string[]>> = profile.reviewed;
  const COMPANIONS: Readonly<Record<string, string>> = profile.build === "26.917.61114" ? ACCOUNTS_NATIVE_10640_COMPANIONS : ACCOUNTS_NATIVE_10492_COMPANIONS;
  const CARRIER_ANCHORS: Readonly<Record<string,string>> = {
    [DATA]: "AppServerRequestClient is missing a message dispatcher", [SHARED]: "defaultQueryOptions(e){",
    [UI]: "You’re out of Codex and Work usage", [PROFILE]: "relative isolate flex flex-col items-center",
    [PLUGINS]: "flex h-full min-h-0 flex-col", [MCP]: "manageOnly:!0",
    [THREAD]: "children:[S,C,w,T,E,D,O,k]", [APPS]: "App setting is overridden by project configuration",
  };
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
  try { validateAccountsNativeMainCarriers(sources, profile.main); } catch (error) { return unavailable((error as Error).message); }
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
    for (const [path, source] of patchAccountsNativeMainSources(sources, hookSetSha256, profile.main)) result.set(path, source);
    edit(SHARED, "defaultQueryOptions(e){if(e._defaulted)return e;", `defaultQueryOptions(e){e=${BRIDGE}.options(e);if(e._defaulted)return e;`);
    for (const anchor of ["getQueriesData(e){", "setQueriesData(e,t,n){", "removeQueries(e){", "resetQueries(e,t){", "cancelQueries(e,t={}){", "invalidateQueries(e,t={}){", "refetchQueries(e,t={}){"]) edit(SHARED, anchor, `${anchor}e=${BRIDGE}.filter(e);`);
    edit(SHARED, "function Nje(e,t,n,{cacheSubscriptions:r,getEnabledReaderOptions:i,getShouldSuppressStaleFetchOnEnable:a,isEnabledReaderMounting:o,shouldRetainFetchStartedAfterUnmount:s}){let c=KN(0)", `function Nje(e,t,n,{cacheSubscriptions:r,getEnabledReaderOptions:i,getShouldSuppressStaleFetchOnEnable:a,isEnabledReaderMounting:o,shouldRetainFetchStartedAfterUnmount:s}){let __twAccountsEpoch=${BRIDGE}.signalEpoch(KN);let c=KN(0)`);
    edit(SHARED, "i=Aje(n(t).defaultQueryOptions(e(t)))", `i=Aje(n(t).defaultQueryOptions(${BRIDGE}.signalOptions(e(t),t,__twAccountsEpoch)))`);
    edit(SHARED, "let t=Aje(n(e).defaultQueryOptions(i(e)));return h(t),t", `let t=Aje(n(e).defaultQueryOptions(${BRIDGE}.signalOptions(i(e),e,__twAccountsEpoch)));return h(t),t`);
    edit(DATA, "async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);return e===`config/read`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===`plugin/list`&&n?.timeoutMs==null?{...n,timeoutMs:Bjt}:n)}", `async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(\`AppServerRequestClient is missing a message dispatcher\`);return ${BRIDGE}.rpc(e,t,()=>e===\`config/read\`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===\`plugin/list\`&&n?.timeoutMs==null?{...n,timeoutMs:Bjt}:n))}`);
    edit(DATA, "a=JSON.stringify({options:i,params:n}),o=t.get(a)", `a=JSON.stringify({options:i,params:n,accountsScope:${BRIDGE}.key("mcp")}),o=t.get(a)`);
    edit(PLUGINS, "Xr(r,m)", 'Xr(r,{...m,accountsNativeSurface:"mcp"})');
    region(DATA, "function _Ut(e,t){", "function vUt(e){", source => once(source, "Yi(p)}", `Yi(${BRIDGE}.configOptions(t?.accountsNativeSurface,p,false,c))}`));
    // Explicit capture is threaded through the shared helper only by scoped callers.
    edit(DATA, "async function FUt(e,t,n){let{layers:r}=await Cv(e,t,n,null,!0);return IUt(r)}", `async function FUt(e,t,n,__twCaptured){let{layers:r}=await ${BRIDGE}.configRead(__twCaptured,()=>Cv(e,t,n,null,!0));return IUt(r)}`);
    edit(APPS, "x=async e=>{let{appId:t,enabled:n}=e,a=await j(i,l,r);if((await A(i,r).sendRequest(`config/batchWrite`,{edits:L({appId:t,enabled:n}),filePath:a?.filePath??null,expectedVersion:a?.expectedVersion??null,reloadUserConfig:!0})).status===`okOverridden`)", `x=async e=>{let __twCaptured=${BRIDGE}.mutationScope("apps",e);let{appId:t,enabled:n}=e,a=await j(i,l,r,__twCaptured);if((await ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:L({appId:t,enabled:n}),filePath:a?.filePath??null,expectedVersion:a?.expectedVersion??null,reloadUserConfig:!0},()=>A(i,r).sendRequest(\`config/batchWrite\`,{edits:L({appId:t,enabled:n}),filePath:a?.filePath??null,expectedVersion:a?.expectedVersion??null,reloadUserConfig:!0}))).status===\`okOverridden\`)`);
    edit(APPS, "let P=p(O)", `let P=${BRIDGE}.mutationHandle("apps",p(${BRIDGE}.mutation("apps",O)))`);
    edit(APPS, "await l.cancelQueries({queryKey:_});let r=", `await l.cancelQueries({queryKey:_});${BRIDGE}.mutationScope("apps",e);let r=`);
    edit(APPS, "(await u(_),l.getQueryData(_)", `(await u(_),${BRIDGE}.mutationScope("apps",t),l.getQueryData(_)`);
    region(DATA, "function kUt(e){", "function AUt(e,t){", source => {
      source = once(source, "u=e=>{let{key:t,enabled:i}=e;return wd(n,r).sendRequest(`config/value/write`,{keyPath:`mcp_servers.${t}.enabled`,value:i,mergeStrategy:`upsert`,filePath:null,expectedVersion:null})}", `u=e=>{let __twCaptured=${BRIDGE}.mutationScope("mcp",e);let{key:t,enabled:i}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"config/value/write",{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:"upsert",filePath:null,expectedVersion:null},()=>wd(n,r).sendRequest(\`config/value/write\`,{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:"upsert",filePath:null,expectedVersion:null}))}`);
      source = once(source, "await Promise.all([i.cancelQueries({queryKey:s}),i.cancelQueries({queryKey:l})]);let r=", `await Promise.all([i.cancelQueries({queryKey:s}),i.cancelQueries({queryKey:l})]);${BRIDGE}.mutationScope("mcp",e);let r=`);
      source = source.replaceAll("queryKey:l", `queryKey:${BRIDGE}.scopedKey("mcp",l)`);
      source = once(source, "AUt(i,l)", `AUt(i,${BRIDGE}.scopedKey("mcp",l))`);
      source = once(source, "a([...Dv,r])", `a(${BRIDGE}.scopedKey("mcp",[...Dv,r]))`);
      source = once(source, ",qa(h)}", `,${BRIDGE}.mutationHandle("mcp",qa(${BRIDGE}.mutation("mcp",h)))}`);
      return source;
    });
    edit(DATA, "let e=await vg.safeGet(`/wham/profiles/me`)", `let __twNativeProfile=await vg.safeGet(\`/wham/profiles/me\`);let e=await ${BRIDGE}.request("profile","profile.statistics",{native:__twNativeProfile},()=>__twNativeProfile)`);
    edit(DATA, "YOn=ga(X,`polling`,", `__twAccountsUsageEpoch=ga(X,0,({set:t})=>{let n=0;return ${BRIDGE}.subscribe("usage",()=>t(++n))}),YOn=ga(X,\`polling\`,`);
    edit(DATA, "XOn=as(X,({get:e})=>{let t=e(YOn),n=e(Czt),r=e(Rg);", `XOn=as(X,({get:e})=>{e(__twAccountsUsageEpoch);let t=${BRIDGE}.key("usage")==="native"?e(YOn):"polling",n=e(Czt),r=e(Rg);`);
    edit(DATA, 'return LOn(await vg.safeGet(`/wham/usage`,{additionalHeaders:{"OAI-App-Brand":rg.toLowerCase(),...e},signal:t}))', `return ${BRIDGE}.usage(LOn(await vg.safeGet(\`/wham/usage\`,{additionalHeaders:{"OAI-App-Brand":rg.toLowerCase(),...e},signal:t})))`);
    edit(DATA, "function Vai(){return vg.safeGet(`/wham/rate-limit-reset-credits`)}", `function Vai(){return ${BRIDGE}.request("usage","usage.credits.read",{},()=>vg.safeGet(\`/wham/rate-limit-reset-credits\`))}`);
    region(DATA, "function Hai(){", "function Uai(e){", source => once(source, "qa(r)}", `${BRIDGE}.mutationHandle("usage",qa(${BRIDGE}.mutation("usage",r)))}`));
    edit(DATA, "function Uai(e){let{creditId:t,redeemRequestId:n}=e;return vg.safePost(`/wham/rate-limit-reset-credits/consume`,{requestBody:{credit_id:t,redeem_request_id:n}})}", `function Uai(e){let __twCaptured=${BRIDGE}.mutationScope("usage",e);let{creditId:t,redeemRequestId:n}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"usage.credits.consume",{creditId:t,redeemRequestId:n},()=>vg.safePost(\`/wham/rate-limit-reset-credits/consume\`,{requestBody:{credit_id:t,redeem_request_id:n}}))}`);
    region(DATA, "async function Oyn(", "async function kyn(", source => {
      source = once(source, "{let m=myn(t.id,n)", `{let __twAppsScope=${BRIDGE}.capture("apps");if(__twAppsScope&&f!=null)return{kind:"failed"};let m=myn(t.id,n)`);
      source = once(source, "u.fetchQuery(tC(t.id,{productSku:m?.productSku}))", `u.fetchQuery(${BRIDGE}.scopedQuery(tC(t.id,{productSku:m?.productSku}),__twAppsScope))`);
      source = source.replaceAll("catch(r){return Xr.error", 'catch(r){if(__twAppsScope)return{kind:"failed"};return Xr.error');
      source = once(source, "if(Lyn(g)||_===`UNSUPPORTED`)return Kyn", 'if(Lyn(g)||_===`UNSUPPORTED`)return __twAppsScope?{kind:"failed"}:Kyn');
      return source.replaceAll("vg.safePost(", `${BRIDGE}.http(vg,"safePost",__twAppsScope)(`);
    });
    region(DATA, "async function Ayn(", "function jyn(", source => {
      source = once(source, "{if(r===`missing_link`)", `{let __twAppsScope=${BRIDGE}.capture("apps");if(r===\`missing_link\`)`);
      source = once(source, "catch(e){Xr.error", 'catch(e){if(__twAppsScope)return{kind:"failed"};Xr.error');
      source = once(source, "if(!e)return{kind:`failed`}", 'if(!e||__twAppsScope)return{kind:`failed`}');
      return source.replaceAll("vg.safePost(", `${BRIDGE}.http(vg,"safePost",__twAppsScope)(`);
    });
    edit(DATA, "if(O=!0,C())return{kind:`missing-callback-data`}", `if(O=!0,!${BRIDGE}.oauthResultCurrent(e)){S!=null&&n9(n,S);o({oauthState:x});E!=null&&Yjc.delete(E);return{kind:"success",appId:e.link.connector_id,appName:e.link?.name?.trim()||_?.appName||"App"}}if(C())return{kind:\`missing-callback-data\`}`);
    // Shared Plugins stay native, including their separate lazy installation module.
    result.set(PREFIX + DATA, result.get(PREFIX + DATA)!.replace(/vg\.safe(Get|Post)\(/g, (_match, verb: string) => `${BRIDGE}.http(vg,"safe${verb}")(`));
    edit(DATA, "usageItems:Ht})", `usageItems:${BRIDGE}.render("account-menu",Ht,{jsx:M4.jsx,react:Z()})})`);
    edit(DATA, "usageWindows:f}=e,p=i!==void 0&&i", `usageWindows:__twNativeWindows}=e,f=${BRIDGE}.project("usage","windows",__twNativeWindows),p=i!==void 0&&i`);
    edit(DATA, "children:[Se,Oe,ke,Ae]", `children:[Se,${BRIDGE}.render("usage",null,{jsx:H$.jsx,react:V$}),Oe,ke,Ae]`);
    for (const original of ["You’re out of Codex and Work usage", "You’ve used all Codex and Work usage", "You’ve reached your usage limit"]) edit(UI, `defaultMessage:\`${original}\``, `defaultMessage:${BRIDGE}.project("usage","depleted-message",${JSON.stringify(original)})`);
    edit(PROFILE, "className:`relative isolate flex flex-col items-center`,children:[Yn,Zn]", `className:\`relative isolate flex flex-col items-center\`,children:[[Yn,Zn],${BRIDGE}.render("profile",null,{jsx:$.jsx,react:Hd})]`);
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
  const assets = [...Object.keys(REVIEWED_ASSETS).map(name => PREFIX + name), profile.main.mainPath, ACCOUNTS_NATIVE_SHARED_PATH].map(path => ({ path, sha256: digest(result.get(path)!) }));
  return { changed: true, sources: result, record: { version: 1, bridgeVersion: 1, build: ACCOUNTS_NATIVE_BUILD, status: "compatible", hooks, hookSetSha256, assets } };
}

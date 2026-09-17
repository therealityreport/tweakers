import { createHash } from "node:crypto";
import { ACCOUNTS_NATIVE_MAIN_PATHS, patchAccountsNativeMainSources } from "./codex-accounts-native-8881-main.js";
import { nativeBootstrapSource } from "./codex-accounts-native.js";
import {
  ACCOUNTS_NATIVE_REQUIRED_HOOKS,
  validateAccountsNativeCompatibility,
  type AccountsNativeCompatibilityRecordV1,
} from "@therealityreport/tweakers-sdk";

export const ACCOUNTS_NATIVE_BUILD = "26.908.40834";
export const ACCOUNTS_NATIVE_9275_BUILD = "26.908.70816";
export const ACCOUNTS_NATIVE_MARKER = "__tweakers_accounts_native_v1__";
const BRIDGE = "globalThis.__tweakersAccountsNativeV1";
const PREFIX = "webview/assets/";

// Reviewed against both the official payload and the same payload with the
// existing model-selection/retention patches. A changed vendor asset needs a
// new review; matching one nearby string is not sufficient compatibility.
const REVIEWED_ASSETS: Readonly<Record<string, readonly string[]>> = {
  "app-initial-9b95fa538c62.js": [
    "737070f94a072d2b4ede9f326e3e1c4142fb82198961251c2e70479b3f926275",
    "2fedc91d3fbf2da1329b834a6172bcee63705bcaef849b3b1c85646e22df53dd"
  ],
  "app-primary-44ec287874b7.js": [
    "28d317396d30902ab5f2c01f069a7b9773f2299b35cc855272d4cf59b402c276"
  ],
  "profile-9e1aa6f4c439.js": [
    "3da8b684f21f4f4cc764173cac0768ef7da2a1504eaf7f954aab8911e821eb4b"
  ],
  "plugins-page-7d29260e396d.js": [
    "0aed5b3c29836bc8a307d44cae88bc096d7e2098c63db99c0c88e4834039e4a0"
  ],
  "mcp-settings-7c0eb7b83df2.js": [
    "fa1cae34d5b55a14c81c4d955d66585bf8fa0a0e26f1fe48c77ee0bba020d1b0"
  ],
  "local-conversation-thread-d531b243ea4e.js": [
    "014788e09176b4be847cec5f702225ce77851f98577525e80e846859b85008e7"
  ]
};
type AccountsNativeRecipe = {
  build: string;
  assets: Readonly<Record<string, { name: string; hashes: readonly string[] }>>;
};
const recipe = (
  build: string,
  names: Readonly<Record<string, { name: string; hashes: readonly string[] }>>,
): AccountsNativeRecipe => ({ build, assets: names });
const ACCOUNTS_NATIVE_8881_RECIPE = recipe(ACCOUNTS_NATIVE_BUILD,
  Object.fromEntries(Object.entries(REVIEWED_ASSETS).map(([name, hashes]) => [name, { name, hashes }])));
const ACCOUNTS_NATIVE_9275_RECIPE = recipe(ACCOUNTS_NATIVE_9275_BUILD, {
  "app-initial-9b95fa538c62.js": { name: "app-initial-4d7ea7f81c2d.js", hashes: [
    "5dcf4a29db25b086f9bd11d053eec60cf0c50bfd988494969cec452e03f19245",
    "d74c857e8691343d21ae481f6f86cabfa29d4f5ce4721a43ece1c08c462d396c",
  ] },
  "app-primary-44ec287874b7.js": { name: "app-primary-4af6ed7f68d1.js", hashes: ["6d75ae321771510842fbcc303846913f7434bc8a67e0c69fb5adb22c632eb3ac"] },
  "profile-9e1aa6f4c439.js": { name: "profile-1eb1afc7cbc2.js", hashes: ["a388d99ab5e01b6f67a511ff9173659397bee729666860ee2e39d9963dc970d2"] },
  "plugins-page-7d29260e396d.js": { name: "plugins-page-8862e0071989.js", hashes: ["c6233c740393efc5bae342d6311a57703226a939d65e59d77d133792bbbbe04b"] },
  "mcp-settings-7c0eb7b83df2.js": { name: "mcp-settings-67e47c4060aa.js", hashes: ["0685d7fcb4b139e4d3c1f5406bfcf829a11ccb7c906830e1770d9576c2c85dfc"] },
  "local-conversation-thread-d531b243ea4e.js": { name: "local-conversation-thread-fe391f4932ed.js", hashes: ["dc9f10d86f1672eaae05e08ee142f6875b3b6a0749f279e1906c53c6c4f895a6"] },
});
const CARRIER_ANCHORS: Readonly<Record<string, string>> = {
  "app-initial-9b95fa538c62.js": "AppServerRequestClient is missing a message dispatcher",
  "app-primary-44ec287874b7.js": "usageItems:",
  "profile-9e1aa6f4c439.js": "flex flex-col items-center",
  "plugins-page-7d29260e396d.js": "flex h-full min-h-0 flex-col",
  "mcp-settings-7c0eb7b83df2.js": "manageOnly:!0",
  "local-conversation-thread-d531b243ea4e.js": "thread-summary",
};

type SourceSet = ReadonlyMap<string, string>;
export interface AccountsNativePatchResult {
  changed: boolean;
  sources: Map<string, string>;
  record: AccountsNativeCompatibilityRecordV1;
}

const digest = (source: string): string => createHash("sha256").update(source).digest("hex");

/** Prepare every replacement before writing any bytes. */
export function patchCodexAccountsNative8881Sources(
  sources: SourceSet,
  previousRecord?: unknown,
): AccountsNativePatchResult {
  return patchCodexAccountsNativeReviewedSources(sources, previousRecord, ACCOUNTS_NATIVE_8881_RECIPE);
}

export function patchCodexAccountsNative9275Sources(
  sources: SourceSet,
  previousRecord?: unknown,
): AccountsNativePatchResult {
  return patchCodexAccountsNativeReviewedSources(sources, previousRecord, ACCOUNTS_NATIVE_9275_RECIPE);
}

function patchCodexAccountsNativeReviewedSources(
  sources: SourceSet,
  previousRecord: unknown,
  selectedRecipe: AccountsNativeRecipe,
): AccountsNativePatchResult {
  const result = new Map(sources);
  const hooks = [...ACCOUNTS_NATIVE_REQUIRED_HOOKS];
  const hookSetSha256 = digest(JSON.stringify(hooks));
  const unavailable = (reason: string): AccountsNativePatchResult => ({
    changed: false, sources: new Map(sources),
    record: { version: 1, bridgeVersion: 1, build: selectedRecipe.build, status: "unavailable", hooks, hookSetSha256, assets: [], reason },
  });
  if ([...sources.values()].some((source) => source.includes(ACCOUNTS_NATIVE_MARKER))) {
    const status = validateAccountsNativeCompatibility(previousRecord, (path) => {
      const source = sources.get(path);
      if (source === undefined) throw new Error("missing asset");
      return source;
    }, digest);
    if (!status.compatible) return unavailable(status.reason ?? "Accounts native integration could not be verified.");
    return { changed: false, sources: result, record: previousRecord as AccountsNativeCompatibilityRecordV1 };
  }
  const actualName = (name: string): string => selectedRecipe.assets[name]?.name ?? name;
  for (const [logicalName, asset] of Object.entries(selectedRecipe.assets)) {
    const name = asset.name;
    const source = sources.get(PREFIX + name);
    if (source === undefined || !asset.hashes.includes(digest(source))) return unavailable("This desktop's Accounts components have not been reviewed. Native behavior was preserved.");
    // Reject duplicated carriers even if the reviewed filename still exists.
    const family = name.replace(/-[a-f0-9]+\.js$/, "-");
    const carrier = new RegExp(`^${PREFIX}${family}[a-f0-9]+\\.js$`);
    if ([...sources].filter(([path, source]) => carrier.test(path) && source.includes(CARRIER_ANCHORS[logicalName])).length !== 1) {
      return unavailable("More than one Accounts component matched this desktop build.");
    }
  }
  const edit = (name: string, anchor: string, replacement: string): void => {
    const path = PREFIX + actualName(name);
    const source = result.get(path)!;
    if (source.split(anchor).length !== 2) throw new Error(`Accounts native hook must match exactly once: ${name}: ${anchor}`);
    result.set(path, source.replace(anchor, replacement));
  };
  const replaceOnce = (source: string, anchor: string | RegExp, replacement: string): string => {
    const count = typeof anchor === "string" ? source.split(anchor).length - 1
      : [...source.matchAll(new RegExp(anchor.source, anchor.flags.includes("g") ? anchor.flags : anchor.flags + "g"))].length;
    if (count !== 1) throw new Error("Accounts native flow replacement must match exactly once: " + anchor);
    return source.replace(anchor, replacement);
  };
  const replaceEvery = (source: string, anchor: string, replacement: string): string => {
    if (!source.includes(anchor)) throw new Error("Accounts native flow replacement is missing: " + anchor);
    return source.replaceAll(anchor, replacement);
  };
  const editRegion = (name: string, start: string, end: string, transform: (source: string) => string): void => {
    const path = PREFIX + actualName(name);
    const source = result.get(path)!;
    if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error(`Accounts native flow must match exactly once: ${name}: ${start} / ${end}`);
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (to < from) throw new Error("Accounts native flow boundaries changed");
    result.set(path, source.slice(0, from) + transform(source.slice(from, to)) + source.slice(to));
  };
  const data = "app-initial-9b95fa538c62.js";
  const ui = "app-primary-44ec287874b7.js";
  try {
    for (const [path, source] of patchAccountsNativeMainSources(sources, hookSetSha256)) result.set(path, source);
    edit(data, "defaultQueryOptions(e){if(e._defaulted)return e;", `defaultQueryOptions(e){e=${BRIDGE}.options(e);if(e._defaulted)return e;`);
    for (const anchor of ["getQueriesData(e){", "setQueriesData(e,t,n){", "removeQueries(e){", "resetQueries(e,t){", "cancelQueries(e,t={}){", "invalidateQueries(e,t={}){", "refetchQueries(e,t={}){"]) {
      edit(data, anchor, `${anchor}e=${BRIDGE}.filter(e);`);
    }
    edit(data, "function _Ct(e,t,n,{cacheSubscriptions:r,getEnabledReaderOptions:i,getShouldSuppressStaleFetchOnEnable:a,isEnabledReaderMounting:o,shouldRetainFetchStartedAfterUnmount:s}){let c=Jf(0)",
      `function _Ct(e,t,n,{cacheSubscriptions:r,getEnabledReaderOptions:i,getShouldSuppressStaleFetchOnEnable:a,isEnabledReaderMounting:o,shouldRetainFetchStartedAfterUnmount:s}){let __twAccountsEpoch=${BRIDGE}.signalEpoch(Jf);let c=Jf(0)`);
    edit(data, "i=pCt(n(t).defaultQueryOptions(e(t)))",
      `i=pCt(n(t).defaultQueryOptions(${BRIDGE}.signalOptions(e(t),t,__twAccountsEpoch)))`);
    edit(data, "let t=pCt(n(e).defaultQueryOptions(i(e)));return h(t),t",
      `let t=pCt(n(e).defaultQueryOptions(${BRIDGE}.signalOptions(i(e),e,__twAccountsEpoch)));return h(t),t`);
    edit(data,
      "async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);return e===`config/read`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===`plugin/list`&&n?.timeoutMs==null?{...n,timeoutMs:Gin}:n)}",
      `async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(\`AppServerRequestClient is missing a message dispatcher\`);return ${BRIDGE}.rpc(e,t,()=>e===\`config/read\`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===\`plugin/list\`&&n?.timeoutMs==null?{...n,timeoutMs:Gin}:n))}`);
    edit(data, "listMcpServers(e,t){let n=JSON.stringify({options:t,params:e})",
      `listMcpServers(e,t){let n=JSON.stringify({options:t,params:e,accountsScope:${BRIDGE}.key("mcp")})`);
    // Tag only the settings consumers. Shared configuration for chat, models,
    // security and project settings keeps its original native query path.
    edit("plugins-page-7d29260e396d.js", "dn(r,p)", `dn(r,{...p,accountsNativeSurface:"mcp"})`);
    edit("plugins-page-7d29260e396d.js", "zn(Ci,U)", `zn(Ci,{...U,accountsNativeSurface:"apps"})`);
    edit("plugins-page-7d29260e396d.js", "je(Kn,B)", `je(Kn,{hostId:B,accountsNativeSurface:"plugins"})`);
    edit(data, "hm(KC,d,{enabled:!u})", `hm(KC,{hostId:d,accountsNativeSurface:"plugins"},{enabled:!u})`);
    editRegion(data, "function mpn(e,t){", "function hpn(e){", (source) => {
      source = replaceOnce(source, "xm(p)}", `xm(${BRIDGE}.configOptions(t?.accountsNativeSurface,p,false,c))}`);
      return source;
    });
    editRegion(data, "function _pn(e,t){", "function vpn(e,t,n,r){", (source) => {
      source = replaceOnce(source, "hm(qC,c,u)", "hm(qC,t?.accountsNativeSurface?{...c,accountsNativeSurface:t.accountsNativeSurface}:c,u)");
      return source;
    });
    edit(data,
      "KC=om(Q,(e,{queryClient:t,scope:n})=>({queryKey:[...HC,e],queryFn:async()=>{try{return{response:await RC(n,t,e,null,!0),readSucceeded:!0}}catch(e){return s.error(`Failed to load config`,{safe:{},sensitive:{error:e}}),{response:Vpn,readSucceeded:!1}}},staleTime:Qx.FIVE_MINUTES,select:({response:{config:e,layers:t},readSucceeded:n})=>({config:e,configReadSucceeded:n,configWriteTarget:Mpn(t),userConfigLayer:Xon(t)})}))",
      `KC=om(Q,(e,{queryClient:t,scope:n})=>{let __twSurface=typeof e==="object"?e.accountsNativeSurface:null;e=typeof e==="object"?e.hostId:e;return ${BRIDGE}.configOptions(__twSurface,{queryKey:[...HC,e],queryFn:async()=>{try{return{response:await RC(n,t,e,null,!0),readSucceeded:!0}}catch(e){return s.error(\`Failed to load config\`,{safe:{},sensitive:{error:e}}),{response:Vpn,readSucceeded:!1}}},staleTime:Qx.FIVE_MINUTES,select:({response:{config:e,layers:t},readSucceeded:n})=>({config:e,configReadSucceeded:n,configWriteTarget:Mpn(t),userConfigLayer:Xon(t)})},true)})`);
    edit(data,
      "qC=om(Q,({cwd:e,hostId:t},{queryClient:n,scope:r})=>({queryKey:[...UC,t,e],queryFn:()=>vpn(r,n,t,e),staleTime:Qx.FIVE_MINUTES,select:({config:e,origins:t,layers:n})=>({config:e,origins:t,layers:n})}))",
      `qC=om(Q,({cwd:e,hostId:t,accountsNativeSurface:__twSurface},{queryClient:n,scope:r})=>${BRIDGE}.configOptions(__twSurface,{queryKey:[...UC,t,e],queryFn:()=>vpn(r,n,t,e),staleTime:Qx.FIVE_MINUTES,select:({config:e,origins:t,layers:n})=>({config:e,origins:t,layers:n})},false,e))`);
    edit(data, "async function jpn(e,t,n){let{layers:r}=await RC(e,t,n,null,!0);return Mpn(r)}",
      `async function jpn(e,t,n,__twCaptured){let{layers:r}=await ${BRIDGE}.configRead(__twCaptured,()=>RC(e,t,n,null,!0));return Mpn(r)}`);
    edit(data, "u=async e=>{let{pluginId:t,enabled:r,marketplaceAnalytics:s,plugin:c,accountId:u}=e",
      `u=async e=>{let __twCaptured=${BRIDGE}.mutationScope("plugins",e);let{pluginId:t,enabled:r,marketplaceAnalytics:s,plugin:c,accountId:u}=e`);
    edit(data, "let e=await jpn(a,o,n);await Dm(a,n).sendRequest(`config/batchWrite`,{edits:xSn({pluginId:t,enabled:r}),filePath:e?.filePath??null,expectedVersion:e?.expectedVersion??null,reloadUserConfig:!0})",
      `let e=await jpn(a,o,n,__twCaptured);await ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:xSn({pluginId:t,enabled:r}),filePath:e?.filePath??null,expectedVersion:e?.expectedVersion??null,reloadUserConfig:!0},()=>Dm(a,n).sendRequest(\`config/batchWrite\`,{edits:xSn({pluginId:t,enabled:r}),filePath:e?.filePath??null,expectedVersion:e?.expectedVersion??null,reloadUserConfig:!0}))`);
    edit(ui, "p=async e=>{let{appId:t,enabled:i}=e,o=await Jhe(r,a,n);if((await vd(r,n).sendRequest(`config/batchWrite`,{edits:Xir({appId:t,enabled:i}),filePath:o?.filePath??null,expectedVersion:o?.expectedVersion??null,reloadUserConfig:!0})).status===`okOverridden`)",
      `p=async e=>{let __twCaptured=${BRIDGE}.mutationScope("apps",e);let{appId:t,enabled:i}=e,o=await Jhe(r,a,n,__twCaptured);if((await ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:Xir({appId:t,enabled:i}),filePath:o?.filePath??null,expectedVersion:o?.expectedVersion??null,reloadUserConfig:!0},()=>vd(r,n).sendRequest(\`config/batchWrite\`,{edits:Xir({appId:t,enabled:i}),filePath:o?.filePath??null,expectedVersion:o?.expectedVersion??null,reloadUserConfig:!0}))).status===\`okOverridden\`)`);
    editRegion(ui, "function Yir(e){", "function Xir(", (source) => {
      source = replaceOnce(source, "let v=Nb(_)", `let v=${BRIDGE}.mutationHandle("apps",Nb(${BRIDGE}.mutation("apps",_)))`);
      source = replaceOnce(source, "await a.cancelQueries({queryKey:u});let r=", `await a.cancelQueries({queryKey:u});${BRIDGE}.mutationScope("apps",e);let r=`);
      source = replaceOnce(source, "(await s(u),a.getQueryData(u)", `(await s(u),${BRIDGE}.mutationScope("apps",t),a.getQueryData(u)`);
      return source;
    });
    editRegion(data, "function A1r(e){", "function j1r(e){", (source) => {
      source = replaceOnce(source, "let g=wm(h)", `let g=${BRIDGE}.mutationHandle("plugins",wm(${BRIDGE}.mutation("plugins",h)))`);
      source = replaceOnce(source, "await Promise.all([o.cancelQueries({queryKey:hO}),o.cancelQueries({queryKey:HC})]);let s=", `await Promise.all([o.cancelQueries({queryKey:hO}),o.cancelQueries({queryKey:HC})]);${BRIDGE}.mutationScope("plugins",e);let s=`);
      source = replaceEvery(source, "HC", `${BRIDGE}.scopedKey("plugins",HC)`);
      return source;
    });
    editRegion(data, "function Tpn(e){", "function Epn(e,t){", (source) => {
      source = replaceOnce(source, "d=e=>{let{key:t,enabled:i}=e;return Dm(n,r).sendRequest(`config/value/write`,{keyPath:`mcp_servers.${t}.enabled`,value:i,mergeStrategy:`upsert`,filePath:null,expectedVersion:null})}", `d=e=>{let __twCaptured=${BRIDGE}.mutationScope("mcp",e);let{key:t,enabled:i}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"config/value/write",{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:\`upsert\`,filePath:null,expectedVersion:null},()=>Dm(n,r).sendRequest(\`config/value/write\`,{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:\`upsert\`,filePath:null,expectedVersion:null}))}`);
      source = replaceOnce(source, "await Promise.all([i.cancelQueries({queryKey:c}),i.cancelQueries({queryKey:u})]);let r=", `await Promise.all([i.cancelQueries({queryKey:c}),i.cancelQueries({queryKey:u})]);${BRIDGE}.mutationScope("mcp",e);let r=`);
      source = replaceEvery(source, "queryKey:u", `queryKey:${BRIDGE}.scopedKey("mcp",u)`);
      source = replaceEvery(source, "Epn(i,u)", `Epn(i,${BRIDGE}.scopedKey("mcp",u))`);
      source = replaceEvery(source, "a([...WC,r])", `a(${BRIDGE}.scopedKey("mcp",[...WC,r]))`);
      source = replaceOnce(source, ",wm(g)}", `,${BRIDGE}.mutationHandle("mcp",wm(${BRIDGE}.mutation("mcp",g)))}`);
      return source;
    });
    editRegion(data, "async function S3a(e){", "async function C3a(", (source) => {
      source = replaceOnce(source, "{let[t,n]", `{let __twCaptured=${BRIDGE}.capture("plugins");let[t,n]`);
      source = replaceOnce(source, "Dm(e,Dh).sendRequest(`plugin/list`,{})", `${BRIDGE}.capturedRpc(__twCaptured,"plugin/list",{},()=>Dm(e,Dh).sendRequest(\`plugin/list\`,{}))`);
      source = replaceOnce(source, "Dm(e,Dh).sendRequest(`config/read`,{includeLayers:!1,cwd:null})", `${BRIDGE}.capturedRpc(__twCaptured,"config/read",{includeLayers:!1,cwd:null},()=>Dm(e,Dh).sendRequest(\`config/read\`,{includeLayers:!1,cwd:null}))`);
      source = replaceOnce(source, "return{...t,configuredPlugins", `${BRIDGE}.ensure(__twCaptured);return{...t,configuredPlugins`);
      return source;
    });
    editRegion(data, "async function w3a(e,t){", "async function T3a(", (source) => {
      source = replaceOnce(source, "{if(t.useBundledMarketplace", `{let __twCaptured=${BRIDGE}.capture("plugins");if(t.useBundledMarketplace`);
      source = replaceEvery(source, "T3a({scope:e,marketplaceName:n,pluginName:t.pluginName})", "T3a({scope:e,marketplaceName:n,pluginName:t.pluginName,accountsCapture:__twCaptured})");
      source = replaceOnce(source, ";if(t.install===!0", `;${BRIDGE}.ensure(__twCaptured);if(t.install===!0`);
      source = replaceOnce(source, "await S1r(e,Dh,{installAttemptId:crypto.randomUUID(),marketplacePath:r.path,pluginName:t.pluginName})", `let __twInstall={installAttemptId:crypto.randomUUID(),marketplacePath:r.path,pluginName:t.pluginName};await ${BRIDGE}.capturedRpc(__twCaptured,"plugin/install",__twInstall,()=>S1r(e,Dh,__twInstall))`);
      source = replaceOnce(source, "await e$r({hostId:Dh,marketplacePath:r.path,pluginName:t.pluginName})", `(${BRIDGE}.ensure(__twCaptured),await e$r({hostId:Dh,marketplacePath:r.path,pluginName:t.pluginName,accountsCapture:__twCaptured}),${BRIDGE}.ensure(__twCaptured))`);
      source = replaceOnce(source, "}if(t.enabled!=null)", `}${BRIDGE}.ensure(__twCaptured);if(t.enabled!=null)`);
      source = replaceOnce(source, "await Dm(e,Dh).sendRequest(`config/batchWrite`,{edits:xSn({pluginId:i.id,enabled:t.enabled}),filePath:null,expectedVersion:null,reloadUserConfig:!0})", `await ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:xSn({pluginId:i.id,enabled:t.enabled}),filePath:null,expectedVersion:null,reloadUserConfig:!0},()=>Dm(e,Dh).sendRequest(\`config/batchWrite\`,{edits:xSn({pluginId:i.id,enabled:t.enabled}),filePath:null,expectedVersion:null,reloadUserConfig:!0}))`);
      source = replaceOnce(source, "return await Iq.browserPluginConfig?.syncAfterPluginChange(),", `return ${BRIDGE}.ensure(__twCaptured),await ${BRIDGE}.capturedRpc(__twCaptured,"browser.sync",{},()=>Iq.browserPluginConfig?.syncAfterPluginChange()),${BRIDGE}.ensure(__twCaptured),`);
      return source;
    });
    editRegion(data, "async function T3a({", "function E3a(", (source) => {
      source = replaceOnce(source, "pluginName:n}){", "pluginName:n,accountsCapture:__twCaptured}){");
      source = replaceOnce(source, "await Dm(e,Dh).sendRequest(`plugin/list`,{})", `await ${BRIDGE}.capturedRpc(__twCaptured,"plugin/list",{},()=>Dm(e,Dh).sendRequest(\`plugin/list\`,{}))`);
      source = replaceOnce(source, ",i=r.find", `;${BRIDGE}.ensure(__twCaptured);let i=r.find`);
      return source;
    });
    edit(data, "async function e$r({hostId:e,marketplacePath:t,pluginName:n}){n$r(n)&&await Iq.chromeNativeHost?.install({hostId:e,marketplacePath:t,pluginName:n})}", `async function e$r({hostId:e,marketplacePath:t,pluginName:n,accountsCapture:__twCaptured}){n$r(n)&&await ${BRIDGE}.capturedRpc(__twCaptured,"browser.install",{hostId:e,marketplacePath:t,pluginName:n},()=>Iq.chromeNativeHost?.install({hostId:e,marketplacePath:t,pluginName:n}))}`);
    edit(data, "async function t$r({hostId:e,marketplaceName:t,pluginName:n}){n$r(n)&&await Iq.chromeNativeHost?.uninstall({hostId:e,marketplaceName:t,pluginName:n})}", `async function t$r({hostId:e,marketplaceName:t,pluginName:n,accountsCapture:__twCaptured}){n$r(n)&&await ${BRIDGE}.capturedRpc(__twCaptured,"browser.uninstall",{hostId:e,marketplaceName:t,pluginName:n},()=>Iq.chromeNativeHost?.uninstall({hostId:e,marketplaceName:t,pluginName:n}))}`);
    edit(data, "t===`local`&&await Iq.browserPluginConfig?.syncAfterPluginChange()", `t===\`local\`&&await ${BRIDGE}.capturedRpc(__twCaptured,"browser.sync",{},()=>Iq.browserPluginConfig?.syncAfterPluginChange())`);
    edit(data, "async function D1r({scope:e,hostId:t,queryClient:n}){", `async function D1r({scope:e,hostId:t,queryClient:n,accountsCapture:__twCaptured}){${BRIDGE}.ensure(__twCaptured);`);
    edit(data, "GQr(e,t,n,{forceReload:!0})", `GQr(e,t,n,{forceReload:!0},__twCaptured)`);
    edit(data, "for(let{cwds:e,response:i}of r)n.setQueryData([...Az,t,e],i)", `for(let{cwds:e,response:i}of r){${BRIDGE}.ensure(__twCaptured);n.setQueryData(__twCaptured?${BRIDGE}.scopedKey("plugins",[...Az,t,e]):[...Az,t,e],i)}`);
    edit(data, "async function GQr(e,t,n=[],r){", "async function GQr(e,t,n=[],r,__twCaptured){");
    edit(data, "await Dm(e,t).sendRequest(`skills/list`,i)", `await ${BRIDGE}.capturedRpc(__twCaptured,"skills/list",i,()=>Dm(e,t).sendRequest(\`skills/list\`,i))`);
    editRegion(data, "async function H1r({", "async function zz(", (source) => {
      source = replaceOnce(source, "queryClient:r}){", "queryClient:r,accountsCapture:__twCaptured}){");
      source = replaceEvery(source, "queryClient:r}", "queryClient:r,accountsCapture:__twCaptured}");
      source = replaceOnce(source, "catch(i){s.error", `catch(i){${BRIDGE}.ensure(__twCaptured);s.error`);
      source = replaceOnce(source, "onClick:async()=>{a.close()", `onClick:async()=>{${BRIDGE}.ensure(__twCaptured);a.close()`);
      return source;
    });
    editRegion(data, "function N1r(e){", "function P1r(e){", (source) => {
      source = replaceOnce(source, "m=async e=>{let{", `m=async e=>{let __twCaptured=${BRIDGE}.mutationScope("plugins",e);let{`);
      source = replaceOnce(source, "await QQr(a,h,!0),i)", `await QQr(a,h,!0),${BRIDGE}.ensure(__twCaptured),i)`);
      source = replaceEvery(source, "DS.safePost(", `${BRIDGE}.http(DS,"safePost",__twCaptured)(`);
      source = replaceOnce(source, "await C1r(a,n,{pluginId:l??r})", `await ${BRIDGE}.capturedRpc(__twCaptured,"plugin/uninstall",{pluginId:l??r},()=>C1r(a,n,{pluginId:l??r}))`);
      source = replaceOnce(source, "H1r({scope:a,hostId:n,intl:u,queryClient:c})", "H1r({scope:a,hostId:n,intl:u,queryClient:c,accountsCapture:__twCaptured})");
      source = replaceOnce(source, "c.cancelQueries({queryKey:p}).then", "(__twCaptured?c.invalidateQueries({queryKey:[`apps`]}):c.cancelQueries({queryKey:p}).then");
      source = replaceOnce(source, "sensitive:{error:e}})}),await Promise.all", "sensitive:{error:e}})})),await Promise.all");
      source = replaceOnce(source, "t$r({hostId:n,marketplaceName:t,pluginName:o})", `(${BRIDGE}.ensure(__twCaptured),t$r({hostId:n,marketplaceName:t,pluginName:o,accountsCapture:__twCaptured}))`);
      source = replaceOnce(source, "o!=null&&a$r(a,o.operationId),zz(l,i)", `zz(e=>{${BRIDGE}.mutationScope("plugins",r);return l(${BRIDGE}.scopedKey("plugins",e))},i)`);
      source = replaceOnce(source, "then(()=>{t??Rz", `then(()=>{${BRIDGE}.mutationScope("plugins",r);t??Rz`);
      source = replaceOnce(source, "let b=wm(y)", `let b=${BRIDGE}.mutationHandle("plugins",wm(${BRIDGE}.mutation("plugins",{...y,meta:{...y.meta,accountsFinalize:(e,t,r,o)=>{o!=null&&a$r(a,o.operationId)}}})))`);
      return source;
    });
    editRegion(data, "be=wm({mutationFn:async(", ",xe=ve||be.isPending", (source) => {
      source = replaceOnce(source, "be=wm({mutationFn:async({hostedAccountId:e,installAttemptId:n,onRpcSettled:r,plugin:a})=>{", `be=${BRIDGE}.mutationHandle("plugins",wm(${BRIDGE}.mutation("plugins",{mutationFn:async(__twVariables)=>{let __twCaptured=${BRIDGE}.mutationScope("plugins",__twVariables);let{hostedAccountId:e,installAttemptId:n,onRpcSettled:r,plugin:a}=__twVariables;`);
      source = replaceEvery(source, "DS.safePost(", `${BRIDGE}.http(DS,"safePost",__twCaptured)(`);
      source = replaceOnce(source, "await S1r(i,t,o)", `await ${BRIDGE}.capturedRpc(__twCaptured,"plugin/install",o,()=>S1r(i,t,o))`);
      source = replaceOnce(source, "e$r({hostId:t,marketplacePath:a.marketplacePath,pluginName:a.plugin.name})", "e$r({hostId:t,marketplacePath:a.marketplacePath,pluginName:a.plugin.name,accountsCapture:__twCaptured})");
      source = replaceOnce(source, "return u||await e$r", `return ${BRIDGE}.ensure(__twCaptured),u||await e$r`);
      source = replaceOnce(source, /\}\}\)$/, "}})))");
      return source;
    });
    editRegion(data, "function sji(){", "function cji(", (source) => {
      source = replaceOnce(source, "wm(r)", `${BRIDGE}.mutationHandle("usage",wm(${BRIDGE}.mutation("usage",r)))`);
      return source;
    });
    // The OAuth rollback record retains data-only provenance from enrollment.
    // A delayed rollback without provenance must never capture today's account.
    edit(data, "let u={accountId:yO(n)?r:void 0,appId:t,expiresAtMs:Date.now()+i1o", `let u={accountsCapture:${BRIDGE}.capture("plugins"),accountId:yO(n)?r:void 0,appId:t,expiresAtMs:Date.now()+i1o`);
    edit(data, "F1r({scope:e,disableBundledAutoInstall:!1", `F1r({accountsCapture:${BRIDGE}.rollbackScope(t.accountsCapture),scope:e,disableBundledAutoInstall:!1`);
    edit(data, "!P8(e,t)){N8(e,t.oauthState);return}yO(t.hostId)||PJn", `!P8(e,t)){N8(e,t.oauthState);return}${BRIDGE}.ensure(t.accountsCapture);yO(t.hostId)||PJn`);
    editRegion(data, "async function F1r({", "function I1r(", (source) => {
      source = replaceOnce(source, "async function F1r({scope:e,", "async function F1r({accountsCapture:__twToken,scope:e,");
      source = replaceOnce(source, "{l?.throwIfAborted();", `{let __twCaptured=__twToken===undefined?${BRIDGE}.capture("plugins"):__twToken;${BRIDGE}.ensure(__twCaptured);l?.throwIfAborted();`);
      source = replaceOnce(source, "await QQr(e,u,!0),l?.throwIfAborted()", `await QQr(e,u,!0),${BRIDGE}.ensure(__twCaptured),l?.throwIfAborted()`);
      source = replaceEvery(source, "DS.safePost(", `${BRIDGE}.http(DS,"safePost",__twCaptured)(`);
      source = replaceOnce(source, "await C1r(e,n,{pluginId:c??i})", `await ${BRIDGE}.capturedRpc(__twCaptured,"plugin/uninstall",{pluginId:c??i},()=>C1r(e,n,{pluginId:c??i}))`);
      source = replaceOnce(source, "D1r({scope:e,hostId:n,queryClient:o})", "D1r({scope:e,hostId:n,queryClient:o,accountsCapture:__twCaptured})");
      source = replaceOnce(source, "o.cancelQueries({queryKey:m}).then", "(__twCaptured?o.invalidateQueries({queryKey:[`apps`]}):o.cancelQueries({queryKey:m}).then");
      source = replaceOnce(source, "sensitive:{error:e}})}),await Promise.all", "sensitive:{error:e}})})),await Promise.all");
      source = replaceOnce(source, "t$r({hostId:n,marketplaceName:r,pluginName:a})", `(${BRIDGE}.ensure(__twCaptured),t$r({hostId:n,marketplaceName:r,pluginName:a,accountsCapture:__twCaptured}))`);
      source = replaceOnce(source, "a$r(e,u),zz(e=>Yx(o,e),d)", `a$r(e,u);if(${BRIDGE}.isCurrent(__twCaptured))zz(e=>{${BRIDGE}.ensure(__twCaptured);return Yx(o,__twCaptured?${BRIDGE}.scopedKey("plugins",e):e)},d)`);
      return source;
    });
    edit(data, "Ne=async(n,r,o)=>{", `Ne=async(n,r,o,__twCaptured)=>{${BRIDGE}.ensure(__twCaptured);`);
    edit(data, "D1r({scope:i,hostId:t,queryClient:l}),e().then", "D1r({scope:i,hostId:t,queryClient:l,accountsCapture:__twCaptured}),e().then");
    edit(data, "if(!f(o))return!1;if(await Me(r),", `if(!${BRIDGE}.isCurrent(__twCaptured)||!f(o))return!1;if(await Me(r),${BRIDGE}.ensure(__twCaptured),`);
    edit(data, "P=Ne(_,v.requiresAppSetup||N?void 0:v.requestId,v.hostedAccountId)", "P=Ne(_,v.requiresAppSetup||N?void 0:v.requestId,v.hostedAccountId,__twInstallScope)");
    edit(data, "Be=async({appConnectingDuringInstall:e,installLockedComputerUse:o=!1,options:d,oauthState:g,plugin:_})=>{",
      `Be=async({appConnectingDuringInstall:e,installLockedComputerUse:o=!1,options:d,oauthState:g,plugin:_})=>{let __twInstallScope=${BRIDGE}.capture("plugins");`);
    edit(data, "C=await be.mutateAsync({hostedAccountId:y,installAttemptId:v.installAttemptId,onRpcSettled:(e,t)=>{j=t,M=e},plugin:_}),!f(y)",
      `${BRIDGE}.ensure(__twInstallScope),C=await be.mutateAsync({hostedAccountId:y,installAttemptId:v.installAttemptId,onRpcSettled:(e,t)=>{j=t,M=e},plugin:_}),${BRIDGE}.ensure(__twInstallScope),!f(y)`);
    edit(data, "await Dm(i,t).sendRequest(`config/batchWrite`,{edits:xSn({pluginId:_.plugin.id,enabled:!0}),filePath:E?.configWriteTarget?.filePath??null,expectedVersion:null,reloadUserConfig:!0})",
      `await ${BRIDGE}.capturedRpc(__twInstallScope,"config/batchWrite",{edits:xSn({pluginId:_.plugin.id,enabled:!0}),filePath:E?.configWriteTarget?.filePath??null,expectedVersion:null,reloadUserConfig:!0},()=>Dm(i,t).sendRequest(\`config/batchWrite\`,{edits:xSn({pluginId:_.plugin.id,enabled:!0}),filePath:E?.configWriteTarget?.filePath??null,expectedVersion:null,reloadUserConfig:!0}))`);
    edit(data, "let e=await DS.safeGet(`/wham/profiles/me`)",
      `let e=await ${BRIDGE}.request("profile","profile.statistics",{},()=>DS.safeGet(\`/wham/profiles/me\`))`);
    edit(data, "let n=await DS.safeGet(`/wham/usage`,{additionalHeaders:{\"OAI-App-Brand\":SS.toLowerCase(),...e},signal:t})",
      `let n=await ${BRIDGE}.usage(await DS.safeGet(\`/wham/usage\`,{additionalHeaders:{"OAI-App-Brand":SS.toLowerCase(),...e},signal:t}))`);
    edit(data, "function oji(){return DS.safeGet(`/wham/rate-limit-reset-credits`)}",
      `function oji(){return ${BRIDGE}.request("usage","usage.credits.read",{},()=>DS.safeGet(\`/wham/rate-limit-reset-credits\`))}`);
    edit(data, "function cji(e){let{creditId:t,redeemRequestId:n}=e;return DS.safePost(`/wham/rate-limit-reset-credits/consume`,{requestBody:{credit_id:t,redeem_request_id:n}})}",
      `function cji(e){let __twCaptured=${BRIDGE}.mutationScope("usage",e);let{creditId:t,redeemRequestId:n}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"usage.credits.consume",{creditId:t,redeemRequestId:n},()=>DS.safePost(\`/wham/rate-limit-reset-credits/consume\`,{requestBody:{credit_id:t,redeem_request_id:n}}))}`);
    // Capture the subscription at flow entry, before detail lookups and native
    // callback-url awaits. A failed scoped flow must not open the signed-in
    // account's browser fallback or silently replay its mutation.
    editRegion(data, "async function JGn(", "async function YGn(", (source) => {
      source = replaceOnce(source, "{let m=a;", `{let __twAppsScope=${BRIDGE}.capture("apps");if(__twAppsScope&&p!=null)return{kind:"failed"};let m=a;`);
      source = replaceOnce(source, "d.fetchQuery(iO(t.id))", `d.fetchQuery(${BRIDGE}.scopedQuery(iO(t.id),__twAppsScope))`);
      source = replaceEvery(source, "catch(r){return s.error", "catch(r){if(__twAppsScope)return{kind:`failed`};return s.error");
      source = replaceOnce(source, "if(rKn(m)||g===`UNSUPPORTED`)return dKn", "if(rKn(m)||g===`UNSUPPORTED`)return __twAppsScope?{kind:`failed`}:dKn");
      source = replaceEvery(source, "DS.safePost(", `${BRIDGE}.http(DS,"safePost",__twAppsScope)(`);
      return source;
    });
    editRegion(data, "async function XGn(", "function ZGn(", (source) => {
      source = replaceOnce(source, "{if(r===`missing_link`)", `{let __twAppsScope=${BRIDGE}.capture("apps");if(r===\`missing_link\`)`);
      source = replaceOnce(source, "catch(e){s.error", "catch(e){if(__twAppsScope)return{kind:`failed`};s.error");
      source = replaceOnce(source, "if(!e)return{kind:`failed`}", "if(!e||__twAppsScope)return{kind:`failed`}");
      source = replaceEvery(source, "DS.safePost(", `${BRIDGE}.http(DS,"safePost",__twAppsScope)(`);
      return source;
    });
    edit(data, "if(k=!0,w())return{kind:`missing-callback-data`}",
      `if(k=!0,!${BRIDGE}.oauthResultCurrent(e)){S!=null&&l(S);o({oauthState:S});D!=null&&R8.delete(D);return{kind:\`success\`,appId:e.link.connector_id,appName:e.link?.name?.trim()||_?.appName||\`App\`}}if(w())return{kind:\`missing-callback-data\`}`);
    // The factory preserves native argument evaluation order and captures
    // account selections before an awaited option expression is evaluated.
    result.set(PREFIX + actualName(data), result.get(PREFIX + actualName(data))!.replace(/DS\.safe(Get|Post)\(/g,
      (_match, verb: string) => `${BRIDGE}.http(DS,"safe${verb}")(`));
    edit(ui, "usageItems:kt})",
      `usageItems:${BRIDGE}.render("account-menu",kt,{jsx:Gz.jsx,react:vGt})})`);
    edit(ui, "let y=v;if(g!=null){", `let y=${BRIDGE}.project("usage","windows",v);if(g!=null){`);
    edit(ui, "children:[ge,Se,Ce,we]",
      `children:[ge,${BRIDGE}.render("usage",null,{jsx:ML.jsx,react:jL}),Se,Ce,we]`);
    for (const original of ["You’re out of Codex and Work usage", "You’ve used all Codex and Work usage", "You’ve reached your usage limit"]) {
      edit(ui, `defaultMessage:\`${original}\``, `defaultMessage:${BRIDGE}.project("usage","depleted-message",${JSON.stringify(original)})`);
    }
    edit("profile-9e1aa6f4c439.js", "className:`flex flex-col items-center`,children:un",
      `className:\`flex flex-col items-center\`,children:${BRIDGE}.render("profile",un,{jsx:$.jsx,react:Hc})`);
    // The native Apps and Plugins browser shares this page. Each selector gets
    // its own account binding; the native list components and actions stay put.
    edit("plugins-page-7d29260e396d.js", "className:`flex h-full min-h-0 flex-col`,children:[vl,bl]",
      `className:\`flex h-full min-h-0 flex-col\`,children:[vl,${BRIDGE}.render("plugins",null,{jsx:$.jsx,react:Q}),${BRIDGE}.render("apps",null,{jsx:$.jsx,react:Q}),bl]`);
    edit("mcp-settings-7c0eb7b83df2.js", "children:(0,p.jsx)(u,{manageOnly:!0})",
      `children:[${BRIDGE}.render("mcp",null,{jsx:p.jsx,react:${BRIDGE}.react()}),(0,p.jsx)(u,{manageOnly:!0})]`);
    edit("local-conversation-thread-d531b243ea4e.js", "children:[m,h,g,_,v,y,b,x]",
      `children:[m,h,g,_,v,${BRIDGE}.render("thread-summary",null,{jsx:oO.jsx,react:__twAccountsThreadReact}),y,b,x]`);
    result.set(PREFIX + actualName("local-conversation-thread-d531b243ea4e.js"), "const __twAccountsThreadReact=r();\n" + result.get(PREFIX + actualName("local-conversation-thread-d531b243ea4e.js")));
    // React's own factory is passed by the app, never imported from a separate
    // React copy. Query setup is initialized before any routed screen mounts.
    result.set(PREFIX + actualName(data), nativeBootstrapSource(hookSetSha256) + "\n" + result.get(PREFIX + actualName(data)));
    for (const name of Object.keys(selectedRecipe.assets).filter((name) => name !== data)) {
      result.set(PREFIX + actualName(name), `/*${ACCOUNTS_NATIVE_MARKER}*/\n` + result.get(PREFIX + actualName(name)));
    }
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Accounts native anchors changed.");
  }
  const assets = [...Object.keys(selectedRecipe.assets).map((name) => PREFIX + actualName(name)), ...ACCOUNTS_NATIVE_MAIN_PATHS]
    .map((path) => ({ path, sha256: digest(result.get(path)!) }));
  return { changed: true, sources: result, record: { version: 1, bridgeVersion: 1, status: "compatible", build: selectedRecipe.build, hooks, hookSetSha256, assets } };
}

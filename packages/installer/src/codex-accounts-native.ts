import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNTS_NATIVE_MAIN_PATHS, patchAccountsNativeMainSources } from "./codex-accounts-native-main.js";
import { patchCodexAccountsNative8881Sources, patchCodexAccountsNative9275Sources } from "./codex-accounts-native-8881.js";
import {
  ACCOUNTS_NATIVE_REQUIRED_HOOKS,
  validateAccountsNativeCompatibility,
  type AccountsNativeCompatibilityRecordV1,
} from "@therealityreport/tweakers-sdk";

export const ACCOUNTS_NATIVE_BUILD = "26.903.61454";
export const ACCOUNTS_NATIVE_MARKER = "__tweakers_accounts_native_v1__";
const BRIDGE = "globalThis.__tweakersAccountsNativeV1";
const PREFIX = "webview/assets/";

// Reviewed against both the official payload and the same payload with the
// existing model-selection/retention patches. A changed vendor asset needs a
// new review; matching one nearby string is not sufficient compatibility.
const REVIEWED_ASSETS: Readonly<Record<string, readonly string[]>> = {
  "app-initial-1b87ae739476.js": [
    "c87b94027faefdc31cc165975dc0f14b28e3f6d922f6a5188756c8f570f2b3d7",
    "eedcac2adb206e98ed0ef324c3d39335d4d9aa938f08dd147cbaefe0e1bd7a9f",
  ],
  "app-primary-e25aaf15dbaf.js": ["0aa689053d9e32d7286dfb1d85ac62cadc3858086335518f15b1f97604eb61e9"],
  "profile-108e93a1eff6.js": ["98c8d57b5527b50c22bca2f6c4187d02868db6e41e0e23d26f0300c53210ce27"],
  "plugins-page-71720e4235f5.js": ["85455837b9f39ad96c410a0950d43cab0fa6ab80433a17690bab39a6e5ddb360"],
  "mcp-settings-7922f9602907.js": ["738b7a6270c79c2afb63408e3d470640141c999a8a05c0e882a1ab713fffa315"],
  "local-conversation-thread-b5c1b90153e1.js": ["a1cc0311cb9535538be33b79b3e8b24da47e1e8d720eed9ec781369e8b8c7c30"],
};
const CARRIER_ANCHORS: Readonly<Record<string, string>> = {
  "app-initial-1b87ae739476.js": "AppServerRequestClient is missing a message dispatcher",
  "app-primary-e25aaf15dbaf.js": "usageItems:",
  "profile-108e93a1eff6.js": "flex flex-col items-center",
  "plugins-page-71720e4235f5.js": "flex h-full min-h-0 flex-col",
  "mcp-settings-7922f9602907.js": "manageOnly:!0",
  "local-conversation-thread-b5c1b90153e1.js": "thread-summary",
};

type SourceSet = ReadonlyMap<string, string>;
export interface AccountsNativePatchResult {
  changed: boolean;
  sources: Map<string, string>;
  record: AccountsNativeCompatibilityRecordV1;
}

const digest = (source: string): string => createHash("sha256").update(source).digest("hex");

/** Prepare every replacement before writing any bytes. */
export function patchCodexAccountsNativeSources(
  sources: SourceSet,
  previousRecord?: unknown,
): AccountsNativePatchResult {
  // Select an explicit recipe, never infer compatibility from the installed
  // version or accept new hashes without reviewing the corresponding hooks.
  if (sources.has("webview/assets/app-initial-9b95fa538c62.js")) {
    return patchCodexAccountsNative8881Sources(sources, previousRecord);
  }
  if (sources.has("webview/assets/app-initial-4d7ea7f81c2d.js")) {
    return patchCodexAccountsNative9275Sources(sources, previousRecord);
  }
  const result = new Map(sources);
  const hooks = [...ACCOUNTS_NATIVE_REQUIRED_HOOKS];
  const hookSetSha256 = digest(JSON.stringify(hooks));
  const unavailable = (reason: string): AccountsNativePatchResult => ({
    changed: false, sources: new Map(sources),
    record: { version: 1, bridgeVersion: 1, build: ACCOUNTS_NATIVE_BUILD, status: "unavailable", hooks, hookSetSha256, assets: [], reason },
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
  for (const [name, hashes] of Object.entries(REVIEWED_ASSETS)) {
    const source = sources.get(PREFIX + name);
    if (source === undefined || !hashes.includes(digest(source))) return unavailable("This desktop's Accounts components have not been reviewed. Native behavior was preserved.");
    // Reject duplicated carriers even if the reviewed filename still exists.
    const family = name.replace(/-[a-f0-9]+\.js$/, "-");
    const carrier = new RegExp(`^${PREFIX}${family}[a-f0-9]+\\.js$`);
    if ([...sources].filter(([path, source]) => carrier.test(path) && source.includes(CARRIER_ANCHORS[name])).length !== 1) {
      return unavailable("More than one Accounts component matched this desktop build.");
    }
  }
  const edit = (name: string, anchor: string, replacement: string): void => {
    const path = PREFIX + name;
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
    const path = PREFIX + name;
    const source = result.get(path)!;
    if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error(`Accounts native flow must match exactly once: ${name}: ${start} / ${end}`);
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (to < from) throw new Error("Accounts native flow boundaries changed");
    result.set(path, source.slice(0, from) + transform(source.slice(from, to)) + source.slice(to));
  };
  const data = "app-initial-1b87ae739476.js";
  const ui = "app-primary-e25aaf15dbaf.js";
  try {
    for (const [path, source] of patchAccountsNativeMainSources(sources, hookSetSha256)) result.set(path, source);
    edit(data, "defaultQueryOptions(e){if(e._defaulted)return e;", `defaultQueryOptions(e){e=${BRIDGE}.options(e);if(e._defaulted)return e;`);
    for (const anchor of ["getQueriesData(e){", "setQueriesData(e,t,n){", "removeQueries(e){", "resetQueries(e,t){", "cancelQueries(e,t={}){", "invalidateQueries(e,t={}){", "refetchQueries(e,t={}){"]) {
      edit(data, anchor, `${anchor}e=${BRIDGE}.filter(e);`);
    }
    edit(data, "function xWt(e,t,n,{getEnabledReaderOptions:r,getShouldSuppressStaleFetchOnEnable:i,isEnabledReaderMounting:a,shouldRetainFetchStartedAfterUnmount:o}){let s=Xv(0)",
      `function xWt(e,t,n,{getEnabledReaderOptions:r,getShouldSuppressStaleFetchOnEnable:i,isEnabledReaderMounting:a,shouldRetainFetchStartedAfterUnmount:o}){let __twAccountsEpoch=${BRIDGE}.signalEpoch(Xv);let s=Xv(0)`);
    edit(data, "r=_Wt(n.defaultQueryOptions(e(t))),o=t(f).get(n)",
      `r=_Wt(n.defaultQueryOptions(${BRIDGE}.signalOptions(e(t),t,__twAccountsEpoch))),o=t(f).get(n)`);
    edit(data, "let t=_Wt(e(d).defaultQueryOptions(r(e)));return m(t),t",
      `let t=_Wt(e(d).defaultQueryOptions(${BRIDGE}.signalOptions(r(e),e,__twAccountsEpoch)));return m(t),t`);
    edit(data,
      "async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);return e===`config/read`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===`plugin/list`&&n?.timeoutMs==null?{...n,timeoutMs:cwn}:n)}",
      `async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(\`AppServerRequestClient is missing a message dispatcher\`);return ${BRIDGE}.rpc(e,t,()=>e===\`config/read\`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,e===\`plugin/list\`&&n?.timeoutMs==null?{...n,timeoutMs:cwn}:n))}`);
    edit(data, "listMcpServers(e,t){let n=JSON.stringify({options:t,params:e})",
      `listMcpServers(e,t){let n=JSON.stringify({options:t,params:e,accountsScope:${BRIDGE}.key("mcp")})`);
    // Tag only the settings consumers. Shared configuration for chat, models,
    // security and project settings keeps its original native query path.
    edit("plugins-page-71720e4235f5.js", "Fn(i,f)", `Fn(i,{...f,accountsNativeSurface:"mcp"})`);
    edit("plugins-page-71720e4235f5.js", "p(bi,Ei)", `p(bi,{...Ei,accountsNativeSurface:"apps"})`);
    edit("plugins-page-71720e4235f5.js", "Ln(et,B)", `Ln(et,{hostId:B,accountsNativeSurface:"plugins"})`);
    edit(data, "ub(WD,u,{enabled:!l})", `ub(WD,{hostId:u,accountsNativeSurface:"plugins"},{enabled:!l})`);
    editRegion(data, "function Gkn(e,t){", "function Kkn(e){", (source) => {
      source = replaceOnce(source, "gb(p)}", `gb(${BRIDGE}.configOptions(t?.accountsNativeSurface,p,false,c))}`);
      return source;
    });
    editRegion(data, "function Jkn(e,t){", "function Ykn(e,t,n,r){", (source) => {
      source = replaceOnce(source, "ub(TAn,c,u)", "ub(TAn,t?.accountsNativeSurface?{...c,accountsNativeSurface:t.accountsNativeSurface}:c,u)");
      return source;
    });
    edit(data,
      "WD=tb(Q,(e,{queryClient:t,scope:n})=>({queryKey:[...BD,e],queryFn:async()=>{try{return{response:await ID(n,t,e,null,!0),readSucceeded:!0}}catch(e){return T.error(`Failed to load config`,{safe:{},sensitive:{error:e}}),{response:SAn,readSucceeded:!1}}},staleTime:nD.FIVE_MINUTES,select:({response:{config:e,layers:t},readSucceeded:n})=>({config:e,configReadSucceeded:n,configWriteTarget:fAn(t),userConfigLayer:pAn(t)})}))",
      `WD=tb(Q,(e,{queryClient:t,scope:n})=>{let __twSurface=typeof e==="object"?e.accountsNativeSurface:null;e=typeof e==="object"?e.hostId:e;return ${BRIDGE}.configOptions(__twSurface,{queryKey:[...BD,e],queryFn:async()=>{try{return{response:await ID(n,t,e,null,!0),readSucceeded:!0}}catch(e){return T.error(\`Failed to load config\`,{safe:{},sensitive:{error:e}}),{response:SAn,readSucceeded:!1}}},staleTime:nD.FIVE_MINUTES,select:({response:{config:e,layers:t},readSucceeded:n})=>({config:e,configReadSucceeded:n,configWriteTarget:fAn(t),userConfigLayer:pAn(t)})},true)})`);
    edit(data,
      "TAn=tb(Q,({cwd:e,hostId:t},{queryClient:n,scope:r})=>({queryKey:[...VD,t,e],queryFn:()=>Ykn(r,n,t,e),staleTime:nD.FIVE_MINUTES,select:({config:e,origins:t,layers:n})=>({config:e,origins:t,layers:n})}))",
      `TAn=tb(Q,({cwd:e,hostId:t,accountsNativeSurface:__twSurface},{queryClient:n,scope:r})=>${BRIDGE}.configOptions(__twSurface,{queryKey:[...VD,t,e],queryFn:()=>Ykn(r,n,t,e),staleTime:nD.FIVE_MINUTES,select:({config:e,origins:t,layers:n})=>({config:e,origins:t,layers:n})},false,e))`);
    edit(data, "async function dAn(e,t,n){let{layers:r}=await ID(e,t,n,null,!0);return fAn(r)}",
      `async function dAn(e,t,n,__twCaptured){let{layers:r}=await ${BRIDGE}.configRead(__twCaptured,()=>ID(e,t,n,null,!0));return fAn(r)}`);
    edit(data, "l=async e=>{let{pluginId:t,enabled:r,marketplaceAnalytics:s,plugin:l,accountId:u}=e",
      `l=async e=>{let __twCaptured=${BRIDGE}.mutationScope("plugins",e);let{pluginId:t,enabled:r,marketplaceAnalytics:s,plugin:l,accountId:u}=e`);
    edit(data, "let e=await dAn(a,o,n);await Sb(a,n).sendRequest(`config/batchWrite`,{edits:pWn({pluginId:t,enabled:r}),filePath:e?.filePath??null,expectedVersion:e?.expectedVersion??null,reloadUserConfig:!0})",
      `let e=await dAn(a,o,n,__twCaptured);await ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:pWn({pluginId:t,enabled:r}),filePath:e?.filePath??null,expectedVersion:e?.expectedVersion??null,reloadUserConfig:!0},()=>Sb(a,n).sendRequest(\`config/batchWrite\`,{edits:pWn({pluginId:t,enabled:r}),filePath:e?.filePath??null,expectedVersion:e?.expectedVersion??null,reloadUserConfig:!0}))`);
    edit(ui, "f=async e=>{let{appId:t,enabled:i}=e,o=await fve(r,a,n);if((await m(r,n).sendRequest(`config/batchWrite`,{edits:cIr({appId:t,enabled:i}),filePath:o?.filePath??null,expectedVersion:o?.expectedVersion??null,reloadUserConfig:!0})).status===`okOverridden`)",
      `f=async e=>{let __twCaptured=${BRIDGE}.mutationScope("apps",e);let{appId:t,enabled:i}=e,o=await fve(r,a,n,__twCaptured);if((await ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:cIr({appId:t,enabled:i}),filePath:o?.filePath??null,expectedVersion:o?.expectedVersion??null,reloadUserConfig:!0},()=>m(r,n).sendRequest(\`config/batchWrite\`,{edits:cIr({appId:t,enabled:i}),filePath:o?.filePath??null,expectedVersion:o?.expectedVersion??null,reloadUserConfig:!0}))).status===\`okOverridden\`)`);
    editRegion(ui, "function sIr(e){", "function cIr(", (source) => {
      source = replaceOnce(source, "let v=TE(_)", `let v=${BRIDGE}.mutationHandle("apps",TE(${BRIDGE}.mutation("apps",_)))`);
      source = replaceOnce(source, "await a.cancelQueries({queryKey:l});let r=", `await a.cancelQueries({queryKey:l});${BRIDGE}.mutationScope("apps",e);let r=`);
      source = replaceOnce(source, "(await o(l),a.getQueryData(l)", `(await o(l),${BRIDGE}.mutationScope("apps",t),a.getQueryData(l)`);
      return source;
    });
    editRegion(data, "function KDi(e){", "function qDi(e){", (source) => {
      source = replaceOnce(source, "let h=yb(m)", `let h=${BRIDGE}.mutationHandle("plugins",yb(${BRIDGE}.mutation("plugins",m)))`);
      source = replaceOnce(source, "await Promise.all([o.cancelQueries({queryKey:Dz}),o.cancelQueries({queryKey:BD})]);let s=", `await Promise.all([o.cancelQueries({queryKey:Dz}),o.cancelQueries({queryKey:BD})]);${BRIDGE}.mutationScope("plugins",e);let s=`);
      source = replaceEvery(source, "BD", `${BRIDGE}.scopedKey("plugins",BD)`);
      return source;
    });
    editRegion(data, "function rAn(e){", "function iAn(e,t){", (source) => {
      source = replaceOnce(source, "u=e=>{let{key:t,enabled:i}=e;return Sb(n,r).sendRequest(`config/value/write`,{keyPath:`mcp_servers.${t}.enabled`,value:i,mergeStrategy:`upsert`,filePath:null,expectedVersion:null})}", `u=e=>{let __twCaptured=${BRIDGE}.mutationScope("mcp",e);let{key:t,enabled:i}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"config/value/write",{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:\`upsert\`,filePath:null,expectedVersion:null},()=>Sb(n,r).sendRequest(\`config/value/write\`,{keyPath:\`mcp_servers.\${t}.enabled\`,value:i,mergeStrategy:\`upsert\`,filePath:null,expectedVersion:null}))}`);
      source = replaceOnce(source, "await Promise.all([i.cancelQueries({queryKey:s}),i.cancelQueries({queryKey:l})]);let r=", `await Promise.all([i.cancelQueries({queryKey:s}),i.cancelQueries({queryKey:l})]);${BRIDGE}.mutationScope("mcp",e);let r=`);
      source = replaceEvery(source, "queryKey:l", `queryKey:${BRIDGE}.scopedKey("mcp",l)`);
      source = replaceEvery(source, "iAn(i,l)", `iAn(i,${BRIDGE}.scopedKey("mcp",l))`);
      source = replaceEvery(source, "a([...HD,r])", `a(${BRIDGE}.scopedKey("mcp",[...HD,r]))`);
      source = replaceOnce(source, ",yb(h)}", `,${BRIDGE}.mutationHandle("mcp",yb(${BRIDGE}.mutation("mcp",h)))}`);
      return source;
    });
    editRegion(data, "async function cPo(e){", "async function lPo(", (source) => {
      source = replaceOnce(source, "{let[t,n]", `{let __twCaptured=${BRIDGE}.capture("plugins");let[t,n]`);
      source = replaceOnce(source, "Sb(e,Gx).sendRequest(`plugin/list`,{})", `${BRIDGE}.capturedRpc(__twCaptured,"plugin/list",{},()=>Sb(e,Gx).sendRequest(\`plugin/list\`,{}))`);
      source = replaceOnce(source, "Sb(e,Gx).sendRequest(`config/read`,{includeLayers:!1,cwd:null})", `${BRIDGE}.capturedRpc(__twCaptured,"config/read",{includeLayers:!1,cwd:null},()=>Sb(e,Gx).sendRequest(\`config/read\`,{includeLayers:!1,cwd:null}))`);
      source = replaceOnce(source, "return{...t,configuredPlugins", `${BRIDGE}.ensure(__twCaptured);return{...t,configuredPlugins`);
      return source;
    });
    editRegion(data, "async function uPo(e,t){", "async function dPo(", (source) => {
      source = replaceOnce(source, "{if(t.useBundledMarketplace", `{let __twCaptured=${BRIDGE}.capture("plugins");if(t.useBundledMarketplace`);
      source = replaceEvery(source, "dPo({scope:e,marketplaceName:n,pluginName:t.pluginName})", "dPo({scope:e,marketplaceName:n,pluginName:t.pluginName,accountsCapture:__twCaptured})");
      source = replaceOnce(source, ";if(t.install===!0", `;${BRIDGE}.ensure(__twCaptured);if(t.install===!0`);
      source = replaceOnce(source, "await RDi(e,Gx,{installAttemptId:crypto.randomUUID(),marketplacePath:r.path,pluginName:t.pluginName})", `let __twInstall={installAttemptId:crypto.randomUUID(),marketplacePath:r.path,pluginName:t.pluginName};await ${BRIDGE}.capturedRpc(__twCaptured,"plugin/install",__twInstall,()=>RDi(e,Gx,__twInstall))`);
      source = replaceOnce(source, "await gEi({hostId:Gx,marketplacePath:r.path,pluginName:t.pluginName})", `(${BRIDGE}.ensure(__twCaptured),await gEi({hostId:Gx,marketplacePath:r.path,pluginName:t.pluginName,accountsCapture:__twCaptured}),${BRIDGE}.ensure(__twCaptured))`);
      source = replaceOnce(source, "}if(t.enabled!=null)", `}${BRIDGE}.ensure(__twCaptured);if(t.enabled!=null)`);
      source = replaceOnce(source, "await Sb(e,Gx).sendRequest(`config/batchWrite`,{edits:pWn({pluginId:i.id,enabled:t.enabled}),filePath:null,expectedVersion:null,reloadUserConfig:!0})", `await ${BRIDGE}.capturedRpc(__twCaptured,"config/batchWrite",{edits:pWn({pluginId:i.id,enabled:t.enabled}),filePath:null,expectedVersion:null,reloadUserConfig:!0},()=>Sb(e,Gx).sendRequest(\`config/batchWrite\`,{edits:pWn({pluginId:i.id,enabled:t.enabled}),filePath:null,expectedVersion:null,reloadUserConfig:!0}))`);
      source = replaceOnce(source, "return await YX.browserPluginConfig?.syncAfterPluginChange(),", `return ${BRIDGE}.ensure(__twCaptured),await ${BRIDGE}.capturedRpc(__twCaptured,"browser.sync",{},()=>YX.browserPluginConfig?.syncAfterPluginChange()),${BRIDGE}.ensure(__twCaptured),`);
      return source;
    });
    editRegion(data, "async function dPo({", "function fPo(", (source) => {
      source = replaceOnce(source, "pluginName:n}){", "pluginName:n,accountsCapture:__twCaptured}){");
      source = replaceOnce(source, "await Sb(e,Gx).sendRequest(`plugin/list`,{})", `await ${BRIDGE}.capturedRpc(__twCaptured,"plugin/list",{},()=>Sb(e,Gx).sendRequest(\`plugin/list\`,{}))`);
      source = replaceOnce(source, ",i=r.find", `;${BRIDGE}.ensure(__twCaptured);let i=r.find`);
      return source;
    });
    edit(data, "async function gEi({hostId:e,marketplacePath:t,pluginName:n}){vEi(n)&&await YX.chromeNativeHost?.install({hostId:e,marketplacePath:t,pluginName:n})}", `async function gEi({hostId:e,marketplacePath:t,pluginName:n,accountsCapture:__twCaptured}){vEi(n)&&await ${BRIDGE}.capturedRpc(__twCaptured,"browser.install",{hostId:e,marketplacePath:t,pluginName:n},()=>YX.chromeNativeHost?.install({hostId:e,marketplacePath:t,pluginName:n}))}`);
    edit(data, "async function _Ei({hostId:e,marketplaceName:t,pluginName:n}){vEi(n)&&await YX.chromeNativeHost?.uninstall({hostId:e,marketplaceName:t,pluginName:n})}", `async function _Ei({hostId:e,marketplaceName:t,pluginName:n,accountsCapture:__twCaptured}){vEi(n)&&await ${BRIDGE}.capturedRpc(__twCaptured,"browser.uninstall",{hostId:e,marketplaceName:t,pluginName:n},()=>YX.chromeNativeHost?.uninstall({hostId:e,marketplaceName:t,pluginName:n}))}`);
    edit(data, "t===`local`&&await YX.browserPluginConfig?.syncAfterPluginChange()", `t===\`local\`&&await ${BRIDGE}.capturedRpc(__twCaptured,"browser.sync",{},()=>YX.browserPluginConfig?.syncAfterPluginChange())`);
    edit(data, "async function UDi({scope:e,hostId:t,queryClient:n}){", `async function UDi({scope:e,hostId:t,queryClient:n,accountsCapture:__twCaptured}){${BRIDGE}.ensure(__twCaptured);`);
    edit(data, "sEi(e,t,n,{forceReload:!0})", `sEi(e,t,n,{forceReload:!0},__twCaptured)`);
    edit(data, "for(let{cwds:e,response:i}of r)n.setQueryData([...RU,t,e],i)", `for(let{cwds:e,response:i}of r){${BRIDGE}.ensure(__twCaptured);n.setQueryData(__twCaptured?${BRIDGE}.scopedKey("plugins",[...RU,t,e]):[...RU,t,e],i)}`);
    edit(data, "async function sEi(e,t,n=[],r){", "async function sEi(e,t,n=[],r,__twCaptured){");
    edit(data, "await Sb(e,t).sendRequest(`skills/list`,i)", `await ${BRIDGE}.capturedRpc(__twCaptured,"skills/list",i,()=>Sb(e,t).sendRequest(\`skills/list\`,i))`);
    editRegion(data, "async function iOi({", "async function qU(", (source) => {
      source = replaceOnce(source, "queryClient:r}){", "queryClient:r,accountsCapture:__twCaptured}){");
      source = replaceEvery(source, "queryClient:r}", "queryClient:r,accountsCapture:__twCaptured}");
      source = replaceOnce(source, "catch(i){T.error", `catch(i){${BRIDGE}.ensure(__twCaptured);T.error`);
      source = replaceOnce(source, "onClick:async()=>{a.close()", `onClick:async()=>{${BRIDGE}.ensure(__twCaptured);a.close()`);
      return source;
    });
    editRegion(data, "function YDi(e){", "function XDi(e){", (source) => {
      source = replaceOnce(source, "p=async e=>{let{", `p=async e=>{let __twCaptured=${BRIDGE}.mutationScope("plugins",e);let{`);
      source = replaceOnce(source, "await mEi(a,m,!0),i)", `await mEi(a,m,!0),${BRIDGE}.ensure(__twCaptured),i)`);
      source = replaceEvery(source, "vO.safePost(", `${BRIDGE}.http(vO,"safePost",__twCaptured)(`);
      source = replaceOnce(source, "await zDi(a,n,{pluginId:c??r})", `await ${BRIDGE}.capturedRpc(__twCaptured,"plugin/uninstall",{pluginId:c??r},()=>zDi(a,n,{pluginId:c??r}))`);
      source = replaceOnce(source, "iOi({scope:a,hostId:n,intl:l,queryClient:s})", "iOi({scope:a,hostId:n,intl:l,queryClient:s,accountsCapture:__twCaptured})");
      source = replaceOnce(source, "s.cancelQueries({queryKey:f}).then", "(__twCaptured?s.invalidateQueries({queryKey:[`apps`]}):s.cancelQueries({queryKey:f}).then");
      source = replaceOnce(source, "sensitive:{error:e}})}),await Promise.all", "sensitive:{error:e}})})),await Promise.all");
      source = replaceOnce(source, "_Ei({hostId:n,marketplaceName:t,pluginName:o})", `(${BRIDGE}.ensure(__twCaptured),_Ei({hostId:n,marketplaceName:t,pluginName:o,accountsCapture:__twCaptured}))`);
      source = replaceOnce(source, "o!=null&&xEi(a,o.operationId),qU(c,i)", `qU(e=>{${BRIDGE}.mutationScope("plugins",r);return c(${BRIDGE}.scopedKey("plugins",e))},i)`);
      source = replaceOnce(source, "then(()=>{t??KU", `then(()=>{${BRIDGE}.mutationScope("plugins",r);t??KU`);
      source = replaceOnce(source, "let y=yb(v)", `let y=${BRIDGE}.mutationHandle("plugins",yb(${BRIDGE}.mutation("plugins",{...v,meta:{...v.meta,accountsFinalize:(e,t,r,o)=>{o!=null&&xEi(a,o.operationId)}}})))`);
      return source;
    });
    editRegion(data, "Se=yb({mutationFn:async(", ",Ce=be||Se.isPending", (source) => {
      source = replaceOnce(source, "Se=yb({mutationFn:async({hostedAccountId:e,installAttemptId:n,onRpcSettled:r,plugin:a})=>{", `Se=${BRIDGE}.mutationHandle("plugins",yb(${BRIDGE}.mutation("plugins",{mutationFn:async(__twVariables)=>{let __twCaptured=${BRIDGE}.mutationScope("plugins",__twVariables);let{hostedAccountId:e,installAttemptId:n,onRpcSettled:r,plugin:a}=__twVariables;`);
      source = replaceEvery(source, "vO.safePost(", `${BRIDGE}.http(vO,"safePost",__twCaptured)(`);
      source = replaceOnce(source, "await RDi(i,t,o)", `await ${BRIDGE}.capturedRpc(__twCaptured,"plugin/install",o,()=>RDi(i,t,o))`);
      source = replaceOnce(source, "gEi({hostId:t,marketplacePath:a.marketplacePath,pluginName:a.plugin.name})", "gEi({hostId:t,marketplacePath:a.marketplacePath,pluginName:a.plugin.name,accountsCapture:__twCaptured})");
      source = replaceOnce(source, "return l||await gEi", `return ${BRIDGE}.ensure(__twCaptured),l||await gEi`);
      source = replaceOnce(source, /\}\}\)$/, "}})))");
      return source;
    });
    editRegion(data, "function w5i(){", "function T5i(", (source) => {
      source = replaceOnce(source, "yb(r)", `${BRIDGE}.mutationHandle("usage",yb(${BRIDGE}.mutation("usage",r)))`);
      return source;
    });
    // The OAuth rollback record retains data-only provenance from enrollment.
    // A delayed rollback without provenance must never capture today's account.
    edit(data, "let u={accountId:jz(n)?r:void 0,appId:t,expiresAtMs:Date.now()+Mys", `let u={accountsCapture:${BRIDGE}.capture("plugins"),accountId:jz(n)?r:void 0,appId:t,expiresAtMs:Date.now()+Mys`);
    edit(data, "ZDi({scope:e,disableBundledAutoInstall:!1", `ZDi({accountsCapture:${BRIDGE}.rollbackScope(t.accountsCapture),scope:e,disableBundledAutoInstall:!1`);
    edit(data, "!V5(e,t)){B5(e,t.oauthState);return}jz(t.hostId)||FBr", `!V5(e,t)){B5(e,t.oauthState);return}${BRIDGE}.ensure(t.accountsCapture);jz(t.hostId)||FBr`);
    editRegion(data, "async function ZDi({", "function QDi(", (source) => {
      source = replaceOnce(source, "async function ZDi({scope:e,", "async function ZDi({accountsCapture:__twToken,scope:e,");
      source = replaceOnce(source, "{c?.throwIfAborted();", `{let __twCaptured=__twToken===undefined?${BRIDGE}.capture("plugins"):__twToken;${BRIDGE}.ensure(__twCaptured);c?.throwIfAborted();`);
      source = replaceOnce(source, "await mEi(e,l,!0),c?.throwIfAborted()", `await mEi(e,l,!0),${BRIDGE}.ensure(__twCaptured),c?.throwIfAborted()`);
      source = replaceEvery(source, "vO.safePost(", `${BRIDGE}.http(vO,"safePost",__twCaptured)(`);
      source = replaceOnce(source, "await zDi(e,n,{pluginId:s??i})", `await ${BRIDGE}.capturedRpc(__twCaptured,"plugin/uninstall",{pluginId:s??i},()=>zDi(e,n,{pluginId:s??i}))`);
      source = replaceOnce(source, "UDi({scope:e,hostId:n,queryClient:o})", "UDi({scope:e,hostId:n,queryClient:o,accountsCapture:__twCaptured})");
      source = replaceOnce(source, "o.cancelQueries({queryKey:p}).then", "(__twCaptured?o.invalidateQueries({queryKey:[`apps`]}):o.cancelQueries({queryKey:p}).then");
      source = replaceOnce(source, "sensitive:{error:e}})}),await Promise.all", "sensitive:{error:e}})})),await Promise.all");
      source = replaceOnce(source, "_Ei({hostId:n,marketplaceName:r,pluginName:a})", `(${BRIDGE}.ensure(__twCaptured),_Ei({hostId:n,marketplaceName:r,pluginName:a,accountsCapture:__twCaptured}))`);
      source = replaceOnce(source, "xEi(e,l),qU(e=>$E(o,e),u)", `xEi(e,l);if(${BRIDGE}.isCurrent(__twCaptured))qU(e=>{${BRIDGE}.ensure(__twCaptured);return $E(o,__twCaptured?${BRIDGE}.scopedKey("plugins",e):e)},u)`);
      return source;
    });
    edit(data, "Fe=async(n,r,o)=>{", `Fe=async(n,r,o,__twCaptured)=>{${BRIDGE}.ensure(__twCaptured);`);
    edit(data, "UDi({scope:i,hostId:t,queryClient:c}),e().then", "UDi({scope:i,hostId:t,queryClient:c,accountsCapture:__twCaptured}),e().then");
    edit(data, "if(!d(o))return!1;if(await Pe(r),", `if(!${BRIDGE}.isCurrent(__twCaptured)||!d(o))return!1;if(await Pe(r),${BRIDGE}.ensure(__twCaptured),`);
    edit(data, "j=Fe(g,_.requiresAppSetup?void 0:_.requestId,_.hostedAccountId)", "j=Fe(g,_.requiresAppSetup?void 0:_.requestId,_.hostedAccountId,__twInstallScope)");
    edit(data, "He=async({appConnectingDuringInstall:e,installLockedComputerUse:o=!1,options:u,oauthState:h,plugin:g})=>{",
      `He=async({appConnectingDuringInstall:e,installLockedComputerUse:o=!1,options:u,oauthState:h,plugin:g})=>{let __twInstallScope=${BRIDGE}.capture("plugins");`);
    edit(data, "S=await Se.mutateAsync({hostedAccountId:v,installAttemptId:_.installAttemptId,onRpcSettled:(e,t)=>{O=t,k=e},plugin:g}),!d(v)",
      `${BRIDGE}.ensure(__twInstallScope),S=await Se.mutateAsync({hostedAccountId:v,installAttemptId:_.installAttemptId,onRpcSettled:(e,t)=>{O=t,k=e},plugin:g}),${BRIDGE}.ensure(__twInstallScope),!d(v)`);
    edit(data, "await Sb(i,t).sendRequest(`config/batchWrite`,{edits:pWn({pluginId:g.plugin.id,enabled:!0}),filePath:E?.configWriteTarget?.filePath??null,expectedVersion:null,reloadUserConfig:!0})",
      `await ${BRIDGE}.capturedRpc(__twInstallScope,"config/batchWrite",{edits:pWn({pluginId:g.plugin.id,enabled:!0}),filePath:E?.configWriteTarget?.filePath??null,expectedVersion:null,reloadUserConfig:!0},()=>Sb(i,t).sendRequest(\`config/batchWrite\`,{edits:pWn({pluginId:g.plugin.id,enabled:!0}),filePath:E?.configWriteTarget?.filePath??null,expectedVersion:null,reloadUserConfig:!0}))`);
    edit(data, "let e=await vO.safeGet(`/wham/profiles/me`)",
      `let e=await ${BRIDGE}.request("profile","profile.statistics",{},()=>vO.safeGet(\`/wham/profiles/me\`))`);
    edit(data, "let e=await vO.safeGet(`/wham/usage`,{additionalHeaders:{\"OAI-App-Brand\":mO.toLowerCase()}})",
      `let e=await ${BRIDGE}.usage(await vO.safeGet(\`/wham/usage\`,{additionalHeaders:{"OAI-App-Brand":mO.toLowerCase()}}))`);
    edit(data, "function C5i(){return vO.safeGet(`/wham/rate-limit-reset-credits`)}",
      `function C5i(){return ${BRIDGE}.request("usage","usage.credits.read",{},()=>vO.safeGet(\`/wham/rate-limit-reset-credits\`))}`);
    edit(data, "function T5i(e){let{creditId:t,redeemRequestId:n}=e;return vO.safePost(`/wham/rate-limit-reset-credits/consume`,{requestBody:{credit_id:t,redeem_request_id:n}})}",
      `function T5i(e){let __twCaptured=${BRIDGE}.mutationScope("usage",e);let{creditId:t,redeemRequestId:n}=e;return ${BRIDGE}.capturedRpc(__twCaptured,"usage.credits.consume",{creditId:t,redeemRequestId:n},()=>vO.safePost(\`/wham/rate-limit-reset-credits/consume\`,{requestBody:{credit_id:t,redeem_request_id:n}}))}`);
    // Capture the subscription at flow entry, before detail lookups and native
    // callback-url awaits. A failed scoped flow must not open the signed-in
    // account's browser fallback or silently replay its mutation.
    editRegion(data, "async function ELr(", "async function DLr(", (source) => {
      source = replaceOnce(source, "{let u=i;", `{let __twAppsScope=${BRIDGE}.capture("apps");let u=i;`);
      source = replaceOnce(source, "c.fetchQuery(mz(t.id))", `c.fetchQuery(${BRIDGE}.scopedQuery(mz(t.id),__twAppsScope))`);
      source = replaceEvery(source, "catch(n){return T.error", "catch(n){if(__twAppsScope)return{kind:`failed`};return T.error");
      source = replaceOnce(source, "if(FLr(u)||d===`UNSUPPORTED`)return ULr", "if(FLr(u)||d===`UNSUPPORTED`)return __twAppsScope?{kind:`failed`}:ULr");
      source = replaceEvery(source, "vO.safePost(", `${BRIDGE}.http(vO,"safePost",__twAppsScope)(`);
      return source;
    });
    editRegion(data, "async function OLr(", "function kLr(", (source) => {
      source = replaceOnce(source, "{if(n===`missing_link`)", `{let __twAppsScope=${BRIDGE}.capture("apps");if(n===\`missing_link\`)`);
      source = replaceOnce(source, "catch(e){T.error", "catch(e){if(__twAppsScope)return{kind:`failed`};T.error");
      source = replaceOnce(source, "if(!e)return{kind:`failed`}", "if(!e||__twAppsScope)return{kind:`failed`}");
      source = replaceEvery(source, "vO.safePost(", `${BRIDGE}.http(vO,"safePost",__twAppsScope)(`);
      return source;
    });
    edit(data, "let e=await vO.safePost(`/aip/connectors/links/oauth/callback`,{requestBody:{full_redirect_url:h}});if(S())",
      `let e=await vO.safePost(\`/aip/connectors/links/oauth/callback\`,{requestBody:{full_redirect_url:h}});if(!${BRIDGE}.oauthResultCurrent(e)){b!=null&&c(b);o({oauthState:b});E!=null&&sbs.delete(E);return{kind:\`success\`,appId:e.link.connector_id,appName:e.link?.name?.trim()||g?.appName||\`App\`}}if(S())`);
    // The factory preserves native argument evaluation order and captures
    // account selections before an awaited option expression is evaluated.
    result.set(PREFIX + data, result.get(PREFIX + data)!.replace(/vO\.safe(Get|Post)\(/g,
      (_match, verb: string) => `${BRIDGE}.http(vO,"safe${verb}")(`));
    edit(ui, "usageItems:wt,workspaceSettingsRightIcon:P",
      `usageItems:${BRIDGE}.render("account-menu",wt,{jsx:dq.jsx,react:Pyn}),workspaceSettingsRightIcon:P`);
    edit(ui, "let y=v;if(g!=null){", `let y=${BRIDGE}.project("usage","windows",v);if(g!=null){`);
    edit(ui, "children:[me,he]}),t[46]=me,t[47]=ge)",
      `children:[me,he,${BRIDGE}.render("usage",null,{jsx:eG.jsx,react:$W})]}),t[46]=me,t[47]=ge)`);
    for (const original of ["You’re out of Codex and Work usage", "You’ve used all Codex and Work usage", "You’ve reached your usage limit"]) {
      edit(ui, `defaultMessage:\`${original}\``, `defaultMessage:${BRIDGE}.project("usage","depleted-message",${JSON.stringify(original)})`);
    }
    edit("profile-108e93a1eff6.js", "className:`flex flex-col items-center`,children:xt",
      `className:\`flex flex-col items-center\`,children:${BRIDGE}.render("profile",xt,{jsx:$.jsx,react:Q})`);
    // The native Apps and Plugins browser shares this page. Each selector gets
    // its own account binding; the native list components and actions stay put.
    edit("plugins-page-71720e4235f5.js", "className:`flex h-full min-h-0 flex-col`,children:[_l,yl]",
      `className:\`flex h-full min-h-0 flex-col\`,children:[_l,${BRIDGE}.render("plugins",null,{jsx:$.jsx,react:Q}),${BRIDGE}.render("apps",null,{jsx:$.jsx,react:Q}),yl]`);
    edit("mcp-settings-7922f9602907.js", "children:(0,p.jsx)(u,{manageOnly:!0})",
      `children:[${BRIDGE}.render("mcp",null,{jsx:p.jsx,react:${BRIDGE}.react()}),(0,p.jsx)(u,{manageOnly:!0})]`);
    edit("local-conversation-thread-b5c1b90153e1.js", "children:[m,h,g,_,v,y,b,x]",
      `children:[m,h,g,_,v,${BRIDGE}.render("thread-summary",null,{jsx:cE.jsx,react:De()}),y,b,x]`);
    // React's own factory is passed by the app, never imported from a separate
    // React copy. Query setup is initialized before any routed screen mounts.
    result.set(PREFIX + data, nativeBootstrapSource(hookSetSha256) + "\n" + result.get(PREFIX + data));
    for (const name of Object.keys(REVIEWED_ASSETS).filter((name) => name !== data)) {
      result.set(PREFIX + name, `/*${ACCOUNTS_NATIVE_MARKER}*/\n` + result.get(PREFIX + name));
    }
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Accounts native anchors changed.");
  }
  const assets = [...Object.keys(REVIEWED_ASSETS).map((name) => PREFIX + name), ...ACCOUNTS_NATIVE_MAIN_PATHS]
    .map((path) => ({ path, sha256: digest(result.get(path)!) }));
  return { changed: true, sources: result, record: { version: 1, bridgeVersion: 1, status: "compatible", build: ACCOUNTS_NATIVE_BUILD, hooks, hookSetSha256, assets } };
}

export function patchCodexAccountsNativeInExtractedApp(appDir: string, previousRecord?: unknown): AccountsNativeCompatibilityRecordV1 {
  const assetsDir = join(appDir, "webview", "assets");
  const sources = new Map<string, string>();
  if (existsSync(assetsDir)) for (const name of readdirSync(assetsDir)) {
    if (!/^(app-initial|app-primary|profile|plugins-page|mcp-settings|local-conversation-thread)-.*\.js$/.test(name)) continue;
    sources.set(PREFIX + name, readFileSync(join(assetsDir, name), "utf8"));
  }
  const mainDir = join(appDir, ".vite", "build");
  if (existsSync(mainDir)) for (const name of readdirSync(mainDir)) {
    if (/^(main|src)-[^/]+\.js$/.test(name)) sources.set(`.vite/build/${name}`, readFileSync(join(mainDir, name), "utf8"));
  }
  const prepared = patchCodexAccountsNativeSources(sources, previousRecord);
  if (prepared.changed) for (const [path, source] of prepared.sources) {
    if (source !== sources.get(path)) writeFileSync(join(appDir, path), source);
  }
  return prepared.record;
}

/** Main-world renderer code. Only plain data crosses the preload boundary. */
export function nativeBootstrapSource(hookSetSha256: string): string {
  // Development's tsx may preserve function names through its local __name
  // helper. Supply the identity helper inside this isolated closure as well.
  return `/*${ACCOUNTS_NATIVE_MARKER}*/\n;((__name)=>{(${accountsNativeBootstrap.toString()})(${JSON.stringify(hookSetSha256)});})((fn)=>fn);`;
}

// Kept as executable JavaScript so the emitted bootstrap and its test oracle
// exercise the same code. Types intentionally remain at the outer boundary.
function accountsNativeBootstrap(hookSetSha256: string): void {
  const page = globalThis as any;
  const transport = page.__tweakersAccountsTransportV1;
  let initialized = false;
  let nativeReact: any = null;
  try { initialized = transport?.initialize({ version: 1, hookSetSha256 }) === true; } catch {}
  const status = () => {
    try { return initialized && transport?.status().compatible === true && transport.status().enabled === true; } catch { return false; }
  };
  const snapshot = (surface: string) => transport.snapshot(surface);
  const current = (surface: string, captured: any) => {
    const next = snapshot(surface);
    return status() && next.accountId === captured.accountId && next.generation === captured.generation;
  };
  const stale = () => Object.assign(new Error("Account selection changed. Refresh this screen."), { name: "AbortError" });
  // Plugins use the native shared catalog. Undefined denotes native ownership;
  // null still denotes an unavailable account-scoped capture for other surfaces.
  const capture = (surface: string) => surface === "plugins" ? undefined : status() ? { surface, ...snapshot(surface) } : null;
  const requestCaptured = async (surface: string, method: string, params: unknown, captured: any, allowSelectionChange = false) => {
    if (!captured || !status() || (!allowSelectionChange && !current(surface, captured))) throw stale();
    try {
      const result = await transport.request(surface, method, params, captured);
      if (!allowSelectionChange && !current(surface, captured)) throw stale();
      return result;
    } catch (error) {
      if (error && typeof error === "object") Object.assign(error, { accountsScoped: true });
      throw error;
    }
  };
  const request = async (surface: string, method: string, params: unknown, fallback: () => unknown) => {
    if (surface === "plugins" || !status()) return fallback();
    const captured = snapshot(surface);
    return requestCaptured(surface, method, params, captured);
  };
  const scopeForMethod = (method: string, params?: any) => {
    if (/^app\/(list|installed|read)$/.test(method)) return "apps";
    if (/^plugin\/(list|read|install|uninstall|share|enable|disable)$/.test(method)) return null;
    if (/^(mcpServerStatus\/list|mcpServer\/oauth\/login)$/.test(method)) return "mcp";
    if (method === "config/value/write" || method === "config/batchWrite") {
      const keys = method === "config/value/write" ? [params?.keyPath] : params?.edits?.map((edit: any) => edit?.keyPath);
      if (Array.isArray(keys) && keys.length) for (const [prefix, surface] of [["apps.", "apps"], ["mcp_servers.", "mcp"]]) {
        if (keys.every((key: unknown) => typeof key === "string" && key.startsWith(prefix))) return surface;
      }
    }
    return null;
  };
  const queryScope = (options: any): string | null => {
    const explicit = options?.meta?.tweakersAccountsSurface;
    if (explicit === "plugins") return null;
    if (["apps", "mcp"].includes(explicit)) return explicit;
    const key = options?.queryKey;
    if (!Array.isArray(key)) return null;
    if (key[0] === "profile" && key[1] === "usage") return "profile";
    if (key[0] === "rate-limit-reset-credits") return "usage";
    if (key[0] === "rate-limit-status") return "usage";
    if (key[0] === "apps") return "apps";
    if (key[0] === "plugins") return null;
    if (key[0] === "mcp") return "mcp";
    if (key[0] === "config" && key[1] === "mcp" && key[2] === "servers") return "mcp";
    if (key[0] === "mcp-settings" && key[1] === "app-connect") return "apps";
    return null;
  };
  const scopeQueryOptions = (options: any, surface: string) => {
    if (surface === "plugins") return options;
    if (Array.isArray(options?.queryKey) && options.queryKey.at(-3) === "tweakers-accounts") return options;
    if (!status()) return options;
    const captured = snapshot(surface);
    const queryFn = options.queryFn;
    const result = {
      ...options,
      queryKey: [...options.queryKey, "tweakers-accounts", captured.accountId ?? "pooled", captured.generation],
      ...(typeof queryFn === "function" ? { queryFn: async (context: any) => {
        if (!current(surface, captured)) throw stale();
        const value = await queryFn(context);
        if (!current(surface, captured)) throw stale();
        return value;
      } } : {}),
    };
    // TanStack skips defaulting preprocessed options; the old hash would then
    // keep the previous account's cache even though its queryKey has changed.
    delete result.queryHash;
    delete result._defaulted;
    return result;
  };
  const oauthStates = new Map<string, { captured: any; expires: number }>();
  const mutationScopes = new WeakMap<object, any>();
  const mutationScope = (surface: string, variables: any) => {
    if (surface === "plugins") return undefined;
    if (!variables || typeof variables !== "object" || !mutationScopes.has(variables)) throw stale();
    const captured = mutationScopes.get(variables);
    if (captured ? captured.surface !== surface || !current(surface, captured) : status()) throw stale();
    return captured;
  };
  const oauthResults = new WeakMap<object, any>();
  const oauthState = (url: unknown) => {
    try { return typeof url === "string" ? new URL(url).searchParams.get("state") : null; } catch { return null; }
  };
  const httpSurface = (verb: string, path: string) => {
    if ((verb === "GET" && ["/aip/connectors/{connector_id}", "/aip/connectors/{connector_id}/link", "/wham/github/installations/v2"].includes(path))
      || (verb === "POST" && ["/aip/connectors/links/list_accessible", "/aip/connectors/links/noauth", "/aip/connectors/links/oauth", "/aip/connectors/links/oauth/complete", "/aip/connectors/links/oauth/reauth", "/aip/connectors/links/oauth/callback", "/aip/connectors/github/has_installations"].includes(path))) return "apps";
    if ((verb === "GET" && ["/ps/plugins/installed", "/ps/plugins/{plugin_id}"].includes(path))
      || (verb === "POST" && ["/ps/plugins/{plugin_id}/install", "/ps/plugins/{plugin_id}/uninstall", "/ps/plugins/{plugin_id}/enable", "/ps/plugins/{plugin_id}/disable", "/apps/availability", "/apps/content", "/apps/workspace/content"].includes(path))) return "plugins";
    return null;
  };
  function NativeSlot(props: any): unknown {
    const { surface, original, context } = props;
    const react = context.react ?? nativeReact;
    const [, rerender] = react.useState(0);
    react.useEffect(() => {
      if (!initialized) return;
      return transport.subscribe((event: any) => {
        if (event.surface === null || event.surface === surface) rerender((n: number) => n + 1);
      });
    }, [surface]);
    if (!status()) return original;
    return context.jsx("div", { "data-tweakers-native-surface": surface, "data-tweakers-native-version": "1" });
  }
  const bridge = {
    render(surface: string, original: unknown, context: any) {
      if (surface === "plugins") return original;
      const react = context.react ?? nativeReact;
      if (!initialized || !react?.useState || !react?.useEffect || typeof context.jsx !== "function") return original;
      return context.jsx(NativeSlot, { surface, original, context: { ...context, react } });
    },
    react() { return nativeReact; },
    capture,
    mutationScope,
    scopedKey(surface: string, key: unknown[]) {
      const captured = capture(surface);
      return captured ? [...key, "tweakers-accounts", captured.accountId ?? "pooled", captured.generation] : key;
    },
    mutation(surface: string, options: any) {
      if (surface === "plugins") {
        if (typeof options.meta?.accountsFinalize !== "function") return options;
        // The patch extracts native operation-lock cleanup into metadata. Keep
        // that cleanup even though shared Plugins no longer use account guards.
        return { ...options, onSettled: (...args: any[]) => {
          options.meta.accountsFinalize(...args);
          return options.onSettled?.(...args);
        } };
      }
      const guarded = { ...options };
      for (const name of ["mutationFn", "onMutate", "onSuccess", "onError", "onSettled"]) {
        const callback = options[name];
        if (typeof callback !== "function" && !(name === "onSettled" && typeof options.meta?.accountsFinalize === "function")) continue;
        guarded[name] = (...args: any[]) => {
          if (name === "onSettled") options.meta?.accountsFinalize?.(...args);
          const variables = args[name === "mutationFn" || name === "onMutate" ? 0 : name === "onSettled" ? 2 : 1];
          try { mutationScope(surface, variables); } catch (error) {
            if (name === "mutationFn" || name === "onMutate") throw error;
            return undefined;
          }
          return callback?.(...args);
        };
      }
      return guarded;
    },
    mutationHandle(surface: string, handle: any) {
      if (surface === "plugins") return handle;
      const wrapped = { ...handle };
      for (const name of ["mutate", "mutateAsync"]) if (typeof handle[name] === "function") {
        wrapped[name] = (variables: any, options?: any) => {
          const bound = { ...variables };
          mutationScopes.set(bound, capture(surface));
          return handle[name](bound, options ? bridge.mutation(surface, options) : options);
        };
      }
      return wrapped;
    },
    rollbackScope(token: any) {
      if (token === undefined) return undefined;
      if ((token === undefined || token === null) && status()) throw Object.assign(new Error("The original install account could not be verified. Refresh Plugins and uninstall manually."), { accountsScoped: true });
      bridge.ensure(token);
      return token ?? null;
    },
    isCurrent(captured: any) { return captured === undefined || (captured ? current(captured.surface, captured) : !status()); },
    ensure(captured: any) { if (captured ? !current(captured.surface, captured) : captured === null && status()) throw stale(); },
    oauthResultCurrent(result: any) { const captured = result && typeof result === "object" ? oauthResults.get(result) : null; return !captured || current("apps", captured); },
    request,
    options(options: any) {
      const surface = queryScope(options);
      return surface ? scopeQueryOptions(options, surface) : options;
    },
    filter(filter: any) {
      const surface = queryScope(filter);
      if (!surface || filter.queryKey?.at(-3) === "tweakers-accounts") return filter;
      const selected = capture(surface);
      const predicate = filter.predicate;
      return { ...filter, predicate: (query: any) => {
        const key = query.queryKey;
        const scoped = Array.isArray(key) && key.at(-3) === "tweakers-accounts";
        const matches = selected ? scoped && key.at(-2) === (selected.accountId ?? "pooled") && key.at(-1) === selected.generation : !scoped;
        return matches && (!predicate || predicate(query));
      } };
    },
    async configRead(captured: any, fallback: () => unknown) {
      bridge.ensure(captured);
      return captured ? requestCaptured(captured.surface, "config/read", { includeLayers: true, cwd: null }, captured) : fallback();
    },
    async capturedRpc(captured: any, method: string, params: unknown, fallback: () => unknown) {
      bridge.ensure(captured);
      return captured ? requestCaptured(captured.surface, method, params, captured) : fallback();
    },
    configOptions(surface: string, options: any, wrapped = false, cwd: string | null = null) {
      if (!["apps", "mcp"].includes(surface)) return options;
      const captured = capture(surface);
      return { ...options, meta: { ...options.meta, tweakersAccountsSurface: surface },
        ...(captured ? { queryFn: async () => {
          const response = await requestCaptured(surface, "config/read", { includeLayers: true, cwd }, captured);
          return wrapped ? { response, readSucceeded: true } : response;
        } } : {}),
      };
    },
    scopedQuery(options: any, captured: any) {
      if (!captured) return options;
      const queryFn = options.queryFn;
      const scoped = scopeQueryOptions(options, captured.surface);
      return { ...scoped, queryFn: async (context: any) => {
        if (!current(captured.surface, captured)) throw stale();
        const result = await queryFn(context);
        if (!current(captured.surface, captured)) throw stale();
        return result;
      } };
    },
    http(client: any, method: string, flowCapture?: any) {
      const explicitCapture = arguments.length >= 3;
      const captured = { apps: capture("apps"), plugins: capture("plugins") };
      return async (path: string, options: any = {}) => {
        const verb = method === "safeGet" ? "GET" : method === "safePost" ? "POST" : "";
        const surface = httpSurface(verb, path);
        if (explicitCapture && flowCapture === undefined) return client[method](path, options);
        if (explicitCapture && flowCapture === null) { bridge.ensure(flowCapture); return client[method](path, options); }
        if (!surface || (!flowCapture && !captured[surface])) return client[method](path, options);
        let selected = flowCapture ?? captured[surface];
        let callback = false;
        if (path === "/aip/connectors/links/oauth/callback") {
          const state = oauthState(options.requestBody?.full_redirect_url);
          const binding = state ? oauthStates.get(state) : null;
          if (!state || !binding || binding.expires < Date.now()) throw stale();
          selected = binding.captured;
          oauthStates.delete(state);
          callback = true;
        }
        const result = await requestCaptured(surface, "http.request", {
          verb, path, options: {
            ...(options.parameters === undefined ? {} : { parameters: options.parameters }),
            ...(options.requestBody === undefined ? {} : { requestBody: options.requestBody }),
          },
        }, selected, callback);
        if (callback && result && typeof result === "object") oauthResults.set(result, selected);
        if (path === "/aip/connectors/links/oauth" || path === "/aip/connectors/links/oauth/reauth") {
          const state = oauthState(result?.redirect_url);
          if (!state) throw Object.assign(new Error("The selected subscription did not return an OAuth state."), { accountsScoped: true });
          for (const [key, binding] of oauthStates) if (binding.expires < Date.now()) oauthStates.delete(key);
          if (oauthStates.size >= 256) oauthStates.delete(oauthStates.keys().next().value!);
          oauthStates.set(state, { captured: selected, expires: Date.now() + 30 * 60_000 });
        }
        return result;
      };
    },
    rpc(method: string, params: unknown, fallback: () => unknown) {
      const surface = scopeForMethod(method, params);
      return surface ? request(surface, method, params ?? {}, fallback) : fallback();
    },
    key(surface: string) { return surface !== "plugins" && status() ? JSON.stringify(snapshot(surface)) : "native"; },
    project(surface: string, kind: string, input: unknown) {
      if (!status()) return input;
      try { return transport.project(surface, kind, input); } catch { return input; }
    },
    usage(native: unknown) { return request("usage", "usage.status", { native }, () => native); },
    signalEpoch(atom: any) {
      const epoch = atom(0);
      epoch.onMount = (set: any) => initialized ? transport.subscribe(() => set((n: number) => n + 1)) : undefined;
      return epoch;
    },
    signalOptions(options: any, get: any, epoch: any) {
      const surface = queryScope(options);
      if (!surface) return options;
      get(epoch);
      return scopeQueryOptions(options, surface);
    },
    queries(options: any[], react: any) {
      nativeReact = react;
      const surfaces = [...new Set(options.map(queryScope).filter(Boolean))];
      const [, rerender] = react.useState(0);
      react.useEffect(() => {
        if (!initialized || !surfaces.length) return;
        return transport.subscribe((event: any) => {
          if (event.surface === null || surfaces.includes(event.surface)) rerender((n: number) => n + 1);
        });
      }, [surfaces.join("\0")]);
      return options.map((entry) => { const surface = queryScope(entry); return surface ? scopeQueryOptions(entry, surface) : entry; });
    },
    query(options: any, react: any) {
      nativeReact = react;
      const surface = queryScope(options);
      const [, rerender] = react.useState(0);
      react.useEffect(() => {
        if (!initialized || !surface) return;
        return transport.subscribe((event: any) => {
          if (event.surface === null || event.surface === surface) rerender((n: number) => n + 1);
        });
      }, [surface]);
      if (!surface || !status()) return options;
      return scopeQueryOptions(options, surface);
    },
  };
  Object.defineProperty(page, "__tweakersAccountsNativeV1", { value: bridge, configurable: false, writable: false });
}

import { createHash } from "node:crypto";
import { nativeAccountsDesktopProjects, nativeAccountsDeviceStorage, preserveNativeBrowserConsumers, nativeAccountsMainFactory } from "./codex-accounts-native-main.js";

export const ACCOUNTS_NATIVE_20156_MAIN_PATH = ".vite/build/main-CqEoQDOU.js";
export const ACCOUNTS_NATIVE_20156_SHARED_PATH = ".vite/build/src-BJv5Mk7n.js";
// Pristine, window-only, then the complete earlier derived-policy/window pair.
// The policy factory serializes differently in source, compiled modules, and
// the deployed sealed Manager bundle. Each complete earlier pair is pinned.
const MAIN_HASHES = [
  "09d19386e1f23cf4ccbc950fc40d85a1e8a064a08be588b2a4be6a89f6ada9e6",
  "b87fdafc594bd38875dcf08c111cc8d370277ff0ce08728836a9d11ee1f55a3b",
  "6c6546f18e6eb5a7ddd123b48386a0aaad7aefaa21b02d3a418e578daa7c5e7c",
  "5d15c52b95ed0a6077c04c77a4129bc3aa3dd9d7be32228b93154f4bed13568a",
  "866185b877839618945eb3e67e225d77e77bb33eae1de02948ad7c29ab1873b0",
];
const SHARED_HASH = "72e2b366d574206f76fc079c79b64c31ce378970a797475ded8709908d338f08";
// Exact independently verified native retention-v2 transform of SHARED_HASH.
const SHARED_RETENTION_V2_HASH = "67b7c9adcc9e604dcd464334e018291a087a7cefa2a0443264874c7256910a4a";
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const SHARED_COMPANIONS: Readonly<Record<string, string>> = {
  ".vite/build/src-CP7XXlpZ.js": "79623d50989f9efbcb8e5752c56b3cc608a0f5993c05112e03e11b718ac7a586",
  ".vite/build/application-network-startup-CfAQmSYg.js": "cd6e8a8fbc4354a6e6ff19c6e4bf6fc1fb3960c63708c83871357c6238f516a8",
  ".vite/build/src-BSoROW9v.js": "02bfe16d532e9de068979823a2409783b03a10d9b9348e8ad6247ba81aca1e16",
  ".vite/build/src-C9YLnbgY.js": "56f4e7f71fb8e93a022d0378322e8fa723a8da07085138957e722e0ac36e9c9d",
};

/** Check the complete carrier inventory, including on an idempotent recheck. */
export function validateAccountsNative20156MainCarriers(sources: ReadonlyMap<string, string>): void {
  const mains = [...sources.keys()].filter(path => /^\.vite\/build\/main-[^/]+\.js$/.test(path));
  if (mains.length !== 1 || mains[0] !== ACCOUNTS_NATIVE_20156_MAIN_PATH) throw new Error("Native Accounts main carrier inventory changed.");
  for (const [path, expected] of Object.entries(SHARED_COMPANIONS)) {
    const source = sources.get(path);
    if (source === undefined || hash(source) !== expected) throw new Error("A reviewed native Accounts companion is missing or changed.");
  }
  for (const [path, source] of sources) {
    if (!/^\.vite\/build\/src-[^/]+\.js$/.test(path) || path === ACCOUNTS_NATIVE_20156_SHARED_PATH) continue;
    if (SHARED_COMPANIONS[path] !== hash(source)) throw new Error("Native Accounts companion inventory changed.");
  }
}

/** Reviewed 20156 bindings; prepare all edits without touching the installed payload. */
export function patchAccountsNative20156MainSources(sources: ReadonlyMap<string, string>, hookSetSha256: string): Map<string, string> {
  validateAccountsNative20156MainCarriers(sources);
  let main = sources.get(ACCOUNTS_NATIVE_20156_MAIN_PATH);
  let shared = sources.get(ACCOUNTS_NATIVE_20156_SHARED_PATH);
  if (!main || !shared || !MAIN_HASHES.includes(hash(main)) || ![SHARED_HASH, SHARED_RETENTION_V2_HASH].includes(hash(shared))) throw new Error("This desktop's native account browser helpers have not been reviewed.");
  if ([...sources].filter(([path, source]) => /^\.vite\/build\/main-[^/]+\.js$/.test(path) && source.includes("async function hc({appServerConnection:e,")).length !== 1) throw new Error("More than one native account browser helper matched.");
  const edit = (anchor: string, replacement: string) => {
    if (main!.split(anchor).length !== 2) throw new Error("Native account browser helper anchor changed: " + anchor);
    main = main!.replace(anchor, () => replacement);
  };
  edit("return{...i,...await Xc({hostConfig:t.hostConfig,appServerVersion:t.appServerVersion}),...a,...o}", "const __twNativeConfig={...i,...await Xc({hostConfig:t.hostConfig,appServerVersion:t.appServerVersion}),...a,...o};return globalThis.__tweakersAttestNativeDesktopConfigV1?.(__twNativeConfig)??__twNativeConfig");
  edit("return o.startThread(a)},B=null,re=null,ie=null", "if(n.kind===`local`&&globalThis.__tweakersAttestNativeDesktopConfigV1)a.config=globalThis.__tweakersAttestNativeDesktopConfigV1(a.config);return o.startThread(a)},B=null,re=null,ie=null");
  edit('"get-global-state":async({key:e})=>({value:this.getGlobalStateValue(e)})', '"get-global-state":async({key:e})=>{await __twAccountsDesktopProjects.ensure(this,e);return{value:this.getGlobalStateValue(e)}}');
  edit('this.deviceStorage=new hue(e.executionCodexHome,u,e=>o.listThreads(e),e=>o.readThread(e,{includeTurns:!1}),C.default.join(_.app.getPath(`userData`),`storage-cache`))', 'this.deviceStorage=__twAccountsDeviceStorage(__twHome=>new hue(__twHome,u,e=>o.listThreads(e),e=>o.readThread(e,{includeTurns:!1}),C.default.join(_.app.getPath(`userData`),`storage-cache`)),e.executionCodexHome)');
  edit('"workspace-root-options":async({canonicalizeRoots:e,hostId:t,signal:n})=>{let r=', '"workspace-root-options":async({canonicalizeRoots:e,hostId:t,signal:n})=>{if(t===`local`)await __twAccountsDesktopProjects.ensure(this);let r=');
  edit("async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();let n=", "async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();if(await __twAccountsDesktopProjects.ensureBackend(this,t))return;e.throwIfAborted();let n=");
  edit("await d4(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())", "await d4(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),await __twAccountsDesktopProjects.ensureWrite(this),r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())");
  edit("async withProjectMetadataLock(e,t,n){", "async withProjectMetadataLock(e,t,n){await __twAccountsDesktopProjects.ensureWrite(this);");
  edit("getInitialSidebarBootstrap(){let e=this.threadCatalogSyncManager;", "getInitialSidebarBootstrap(){void __twAccountsDesktopProjects.ensure(this.fetchHandler).catch(()=>{});let e=this.threadCatalogSyncManager;");
  edit("async function hc({appServerConnection:e,", "async function hc({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("_=await ks({appServerConnection:e,desktopFeatureAvailability:m,marketplaces:g,", "_=await ks({codexHome:__twAccountsHome,appServerConnection:e,desktopFeatureAvailability:m,marketplaces:g,");
  edit("async function ks({appServerConnection:e,", "async function ks({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("let o=c.ot(),s=r.$o(p.t.resolve()),l=aa(a)", "let o=__twAccountsHome??c.ot(),s=r.$o(p.t.resolve()),l=aa(a)");
  const removal = "(i.length!==0||a)&&(RV.info(`chrome_native_host_manifest_remove_requested`";
  if (shared.split(removal).length !== 2) throw new Error("Native browser consumer preservation anchor changed.");
  shared = shared.replace(removal, () => "if(e.preserveRetainedConsumers===!0)return __twAccountsPreserveNativeConsumers({manifestPaths:i,nativeHostName:t,pluginCacheRoot:r});" + removal);
  // 20156 splits the consumer registry into a platform registry (jH) plus a per-home copy; both are
  // written together, so the platform registry remains the complete consumer inventory.
  shared += `\n;var __twAccountsPreserveNativeConsumers=((__name)=>(input)=>(${preserveNativeBrowserConsumers.toString()})(input,{fs:p.default,path:m,registryPath:jH,readRegistry:xH,parseConsumer:OH,ownsManifest:$H,write:BH,removeRegistration:_U,description:JV,uid:process.getuid?.(),Buffer}))((fn)=>fn);\n`;
  main += `\n;var __twAccountsDesktopProjects=((__name)=>(${nativeAccountsDesktopProjects.toString()})({enabled:()=>globalThis.__tweakersAccountsDesktopProjectsEnabledV1?.()===true,hostKey:()=>\`local:\${c.ot()}\`,onFocus:(fn)=>_.app.on("browser-window-focus",fn)}))((fn)=>fn);\n`;
  main += `\n;var __twAccountsDeviceStorage=((__name)=>(factory,fallback)=>(${nativeAccountsDeviceStorage.toString()})(factory,fallback,()=>globalThis.__tweakersAccountsStorageHomeV1?.()??null))((fn)=>fn);\n`;
  main += `\n;((__name)=>{Object.defineProperty(globalThis,"__tweakersAccountsNativeMainV1",{value:{version:1,hookSetSha256:${JSON.stringify(hookSetSha256)},refreshProjects:()=>__twAccountsDesktopProjects.refresh(),create:(input)=>(${nativeAccountsMainFactory.toString()})(input,{sync:(options)=>new pc(options).syncAfterPluginChange(),install:(options)=>i.Qt(options),uninstall:(options)=>i.en(options),appVersion:_.app.getVersion(),isPackaged:_.app.isPackaged,resourcesPath:process.resourcesPath})},configurable:false,writable:false});})((fn)=>fn);\n`;
  return new Map([[ACCOUNTS_NATIVE_20156_MAIN_PATH, main], [ACCOUNTS_NATIVE_20156_SHARED_PATH, shared]]);
}

import { createHash } from "node:crypto";
import { nativeAccountsDesktopProjects, nativeAccountsDeviceStorage, preserveNativeBrowserConsumers, nativeAccountsMainFactory } from "./codex-accounts-native-main.js";

export const ACCOUNTS_NATIVE_20398_MAIN_PATH = ".vite/build/main-CwxgTOle.js";
export const ACCOUNTS_NATIVE_20398_SHARED_PATH = ".vite/build/src-DCNiwad_.js";
// Pristine, window-only, then the complete earlier derived-policy/window pair.
// The policy factory serializes differently in source, compiled modules, and
// the deployed sealed Manager bundle. Each complete earlier pair is pinned.
const MAIN_HASHES = [
  "87d52265eb13608a380fabcac47ecf13a39b981115c0960c18af563ea6d32d51",
  "5d08e3c9aa2d86114234f6e1b6ff9ef6c2474e991103157e06d35be91b1faa22",
  "2c60f3bf0b12dbdaee88962673d1c0629a678676ab33b93ac162a5d86a836603",
  "70a5e142d90356580709a3f023cfe86c993e7114d53c1a9ff153c12bcb5a153c",
  "be30f34d97e6cbc55b1e31ac8b51a7f0b0d5bd449cf64383cf7c92e1a5565c85"
];
const SHARED_HASH = "86fb2066bbc2f7428864b76b46ef570b09eb1e92e81e9d6f089f5b048a66df25";
// Exact independently verified native retention-v2 transform of SHARED_HASH.
const SHARED_RETENTION_V2_HASH = "fa99035d71c02797070076774133ad80008c467a106ff942990eee29657f8394";
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const SHARED_COMPANIONS: Readonly<Record<string, string>> = {
  ".vite/build/application-network-startup-YSC7OAs0.js": "52f0be375fb08281e88ad41be64220fb73f85210523e53e7d7acf094fda6344e",
  ".vite/build/src-BSoROW9v.js": "02bfe16d532e9de068979823a2409783b03a10d9b9348e8ad6247ba81aca1e16",
  ".vite/build/src-C9YLnbgY.js": "56f4e7f71fb8e93a022d0378322e8fa723a8da07085138957e722e0ac36e9c9d",
  ".vite/build/src-CP7XXlpZ.js": "79623d50989f9efbcb8e5752c56b3cc608a0f5993c05112e03e11b718ac7a586"
};

/** Check the complete carrier inventory, including on an idempotent recheck. */
export function validateAccountsNative20398MainCarriers(sources: ReadonlyMap<string, string>): void {
  const mains = [...sources.keys()].filter(path => /^\.vite\/build\/main-[^/]+\.js$/.test(path));
  if (mains.length !== 1 || mains[0] !== ACCOUNTS_NATIVE_20398_MAIN_PATH) throw new Error("Native Accounts main carrier inventory changed.");
  for (const [path, expected] of Object.entries(SHARED_COMPANIONS)) {
    const source = sources.get(path);
    if (source === undefined || hash(source) !== expected) throw new Error("A reviewed native Accounts companion is missing or changed.");
  }
  for (const [path, source] of sources) {
    if (!/^\.vite\/build\/src-[^/]+\.js$/.test(path) || path === ACCOUNTS_NATIVE_20398_SHARED_PATH) continue;
    if (SHARED_COMPANIONS[path] !== hash(source)) throw new Error("Native Accounts companion inventory changed.");
  }
}

/** Reviewed 20398 bindings; prepare all edits without touching the installed payload. */
export function patchAccountsNative20398MainSources(sources: ReadonlyMap<string, string>, hookSetSha256: string): Map<string, string> {
  validateAccountsNative20398MainCarriers(sources);
  let main = sources.get(ACCOUNTS_NATIVE_20398_MAIN_PATH);
  let shared = sources.get(ACCOUNTS_NATIVE_20398_SHARED_PATH);
  if (!main || !shared || !MAIN_HASHES.includes(hash(main)) || ![SHARED_HASH, SHARED_RETENTION_V2_HASH].includes(hash(shared))) throw new Error("This desktop's native account browser helpers have not been reviewed.");
  if ([...sources].filter(([path, source]) => /^\.vite\/build\/main-[^/]+\.js$/.test(path) && source.includes("async function Lc({appServerConnection:e,")).length !== 1) throw new Error("More than one native account browser helper matched.");
  const edit = (anchor: string, replacement: string) => {
    if (main!.split(anchor).length !== 2) throw new Error("Native account browser helper anchor changed: " + anchor);
    main = main!.replace(anchor, () => replacement);
  };
  edit("return{...i,...await vl({hostConfig:t.hostConfig,appServerVersion:t.appServerVersion}),...a,...o}", "const __twNativeConfig={...i,...await vl({hostConfig:t.hostConfig,appServerVersion:t.appServerVersion}),...a,...o};return globalThis.__tweakersAttestNativeDesktopConfigV1?.(__twNativeConfig)??__twNativeConfig");
  edit("return o.startThread(a)},B=null,re=null,ie=null", "if(n.kind===`local`&&globalThis.__tweakersAttestNativeDesktopConfigV1)a.config=globalThis.__tweakersAttestNativeDesktopConfigV1(a.config);return o.startThread(a)},B=null,re=null,ie=null");
  edit('"get-global-state":async({key:e})=>({value:this.getGlobalStateValue(e)})', '"get-global-state":async({key:e})=>{await __twAccountsDesktopProjects.ensure(this,e);return{value:this.getGlobalStateValue(e)}}');
  edit('this.deviceStorage=new tv(e.executionCodexHome,u,e=>o.listThreads(e),e=>o.readThread(e,{includeTurns:!1}),C.default.join(_.app.getPath(`userData`),`storage-cache`))', 'this.deviceStorage=__twAccountsDeviceStorage(__twHome=>new tv(__twHome,u,e=>o.listThreads(e),e=>o.readThread(e,{includeTurns:!1}),C.default.join(_.app.getPath(`userData`),`storage-cache`)),e.executionCodexHome)');
  edit('"workspace-root-options":async({canonicalizeRoots:e,hostId:t,signal:n})=>{let r=', '"workspace-root-options":async({canonicalizeRoots:e,hostId:t,signal:n})=>{if(t===`local`)await __twAccountsDesktopProjects.ensure(this);let r=');
  edit("async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();let n=", "async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();if(await __twAccountsDesktopProjects.ensureBackend(this,t))return;e.throwIfAborted();let n=");
  edit("await u4(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())", "await u4(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),await __twAccountsDesktopProjects.ensureWrite(this),r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())");
  edit("async withProjectMetadataLock(e,t,n){", "async withProjectMetadataLock(e,t,n){await __twAccountsDesktopProjects.ensureWrite(this);");
  edit("async function Q2(e,t,n,r){let i=()=>r.throwIfAborted();if(t.bundledPluginMarketplacePaths.length===0)return;",
    "async function Q2(e,t,n,r){let i=()=>r.throwIfAborted();if(t.bundledPluginMarketplacePaths.length===0)return;if(await __twAccountsRuntimePlugins(e,t,r))return;");
  edit("async function $2(e,t,n){if(t.skillsToRemove.length===0&&t.bundledSkillPaths.length===0)return;let r=await e.codexHome();if(n.throwIfAborted(),await gHe",
    "async function $2(e,t,n){if(t.skillsToRemove.length===0&&t.bundledSkillPaths.length===0)return;let r=await e.codexHome();__twAccountsRuntimeSkillHome(e,r);if(n.throwIfAborted(),await gHe");
  edit("getInitialSidebarBootstrap(){let e=this.threadCatalogSyncManager;", "getInitialSidebarBootstrap(){void __twAccountsDesktopProjects.ensure(this.fetchHandler).catch(()=>{});let e=this.threadCatalogSyncManager;");
  edit("async function Lc({appServerConnection:e,", "async function Lc({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("_=await Ls({appServerConnection:e,desktopFeatureAvailability:m,marketplaces:g,", "_=await Ls({codexHome:__twAccountsHome,appServerConnection:e,desktopFeatureAvailability:m,marketplaces:g,");
  edit("async function Ls({appServerConnection:e,", "async function Ls({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("let o=c.ot(),s=r.$o(p.t.resolve()),l=oa(a)", "let o=__twAccountsHome??c.ot(),s=r.$o(p.t.resolve()),l=oa(a)");
  const removal = "(i.length!==0||a)&&(RV.info(`chrome_native_host_manifest_remove_requested`";
  if (shared.split(removal).length !== 2) throw new Error("Native browser consumer preservation anchor changed.");
  shared = shared.replace(removal, () => "if(e.preserveRetainedConsumers===!0)return __twAccountsPreserveNativeConsumers({manifestPaths:i,nativeHostName:t,pluginCacheRoot:r});" + removal);
  // 20398 splits the consumer registry into a platform registry (jH) plus a per-home copy; both are
  // written together, so the platform registry remains the complete consumer inventory.
  shared += `\n;var __twAccountsPreserveNativeConsumers=((__name)=>(input)=>(${preserveNativeBrowserConsumers.toString()})(input,{fs:p.default,path:m,registryPath:jH,readRegistry:xH,parseConsumer:OH,ownsManifest:$H,write:BH,removeRegistration:_U,description:JV,uid:process.getuid?.(),Buffer}))((fn)=>fn);\n`;
  main += `\n;var __twAccountsDesktopProjects=((__name)=>(${nativeAccountsDesktopProjects.toString()})({enabled:()=>globalThis.__tweakersAccountsDesktopProjectsEnabledV1?.()===true,hostKey:()=>\`local:\${c.ot()}\`,onFocus:(fn)=>_.app.on("browser-window-focus",fn)}))((fn)=>fn);\n`;
  main += `\n;var __twAccountsDeviceStorage=((__name)=>(factory,fallback)=>(${nativeAccountsDeviceStorage.toString()})(factory,fallback,()=>globalThis.__tweakersAccountsStorageHomeV1?.()??null))((fn)=>fn);\n`;
  main += `\n;var __twAccountsRuntimeHomes=new WeakMap;var __twAccountsRuntimePlugins=((__name)=>(connection,paths,signal)=>{__twAccountsRuntimeHomes.delete(connection);return (${nativeAccountsRuntimePluginSync.toString()})(connection,paths,signal,{enabled:()=>globalThis.__tweakersAccountsDesktopProjectsEnabledV1?.()===true,listParams:Pa,readMarketplace:ds,bindHome:(connection,home)=>__twAccountsRuntimeHomes.set(connection,home),report:(plugins)=>z2().info("primary_runtime_plugins_native_owned",{safe:{policy:"follow-native",plugins}})})})((fn)=>fn);var __twAccountsRuntimeSkillHome=((__name)=>(connection,home)=>(${nativeAccountsRuntimeSkillHome.toString()})(connection,home,__twAccountsRuntimeHomes))((fn)=>fn);\n`;
  main += `\n;((__name)=>{Object.defineProperty(globalThis,"__tweakersAccountsNativeMainV1",{value:{version:1,hookSetSha256:${JSON.stringify(hookSetSha256)},refreshProjects:()=>__twAccountsDesktopProjects.refresh(),create:(input)=>(${nativeAccountsMainFactory.toString()})(input,{sync:(options)=>new Fc(options).syncAfterPluginChange(),install:(options)=>i.Qt(options),uninstall:(options)=>i.en(options),appVersion:_.app.getVersion(),isPackaged:_.app.isPackaged,resourcesPath:process.resourcesPath})},configurable:false,writable:false});})((fn)=>fn);\n`;
  return new Map([[ACCOUNTS_NATIVE_20398_MAIN_PATH, main], [ACCOUNTS_NATIVE_20398_SHARED_PATH, shared]]);
}

/** The dependency bundle and native-owned definitions have independent versions. */
export async function nativeAccountsRuntimePluginSync(connection: any, paths: any, signal: any, deps: any): Promise<boolean> {
  if (!deps.enabled()) return false;
  signal.throwIfAborted();
  const result = await connection.listPlugins({ ...deps.listParams, tweakersRuntimeOwnership: true }, () => signal.throwIfAborted());
  signal.throwIfAborted();
  if (!result || typeof result !== "object" || !("tweakersPluginOwnership" in result)) return false;
  const owner = result.tweakersPluginOwnership;
  const fail = () => { throw new Error("Native-owned primary runtime plugin definitions are unavailable"); };
  if (!owner || owner.version !== 1 || owner.policy !== "follow-native" || !Array.isArray(owner.plugins)
    || owner.plugins.length === 0 || owner.plugins.length > 64 || !Array.isArray(result.marketplaces)
    || !Array.isArray(result.marketplaceLoadErrors) || result.marketplaceLoadErrors.length !== 0) return fail();
  // The following stock skill migration may write. Bind its cached home to
  // the broker's currently verified, native-disjoint execution home first.
  if (typeof owner.home !== "string" || await connection.codexHome() !== owner.home) return fail();
  signal.throwIfAborted();
  const proofs = new Map<string, string>();
  for (const plugin of owner.plugins) {
    if (!plugin || typeof plugin.id !== "string" || !/^[a-z0-9][a-z0-9-]*@openai-primary-runtime$/.test(plugin.id)
      || typeof plugin.version !== "string" || !plugin.version || plugin.version.length > 128 || proofs.has(plugin.id)) return fail();
    proofs.set(plugin.id, plugin.version);
  }
  const expected = new Set<string>();
  if (!Array.isArray(paths.bundledPluginMarketplacePaths) || paths.bundledPluginMarketplacePaths.length !== 1) return fail();
  for (const path of paths.bundledPluginMarketplacePaths) {
    signal.throwIfAborted();
    const marketplace = await deps.readMarketplace(path);
    signal.throwIfAborted();
    if (!marketplace || marketplace.name !== "openai-primary-runtime" || !Array.isArray(marketplace.plugins)
      || marketplace.plugins.length === 0 || marketplace.plugins.length > 64) return fail();
    const installed = result.marketplaces.filter((row: any) => row?.name === marketplace.name);
    if (installed.length !== 1 || !Array.isArray(installed[0].plugins)) return fail();
    for (const plugin of marketplace.plugins) {
      const id = `${plugin?.name}@${marketplace.name}`;
      const rows = installed[0].plugins.filter((row: any) => row?.id === id);
      if (expected.has(id) || !proofs.has(id) || rows.length !== 1 || rows[0].installed !== true
        || rows[0].sharedDefinitionState === "unavailable") return fail();
      expected.add(id);
    }
  }
  if (expected.size !== proofs.size) return fail();
  signal.throwIfAborted();
  deps.report([...proofs].map(([id, version]) => ({ id, version })));
  deps.bindHome(connection, owner.home);
  return true;
}

/** Check the second native home read at the actual legacy-skill write boundary. */
export function nativeAccountsRuntimeSkillHome(connection: object, home: string, homes: WeakMap<object, string>): void {
  const expected = homes.get(connection);
  if (expected !== undefined && home !== expected) throw new Error("Native-owned runtime skill home changed");
}

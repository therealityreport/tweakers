import { createHash } from "node:crypto";
import { nativeAccountsDesktopProjects, preserveNativeBrowserConsumers, nativeAccountsMainFactory } from "./codex-accounts-native-main.js";

export const ACCOUNTS_NATIVE_MAIN_PATH = ".vite/build/main-DUHZj4_w.js";
export const ACCOUNTS_NATIVE_SHARED_PATH = ".vite/build/src-C3YaUE83.js";
export const ACCOUNTS_NATIVE_MAIN_PATHS = [ACCOUNTS_NATIVE_MAIN_PATH, ACCOUNTS_NATIVE_SHARED_PATH] as const;
const MAIN_HASHES = ["9e8a3bd79c817064f28693ca26aa1378895e07ab2108c78c42d0ea20dac9d66e", "a4786f9a9f7121b07227085cf04e99b5f31e2ef5523df168911075b18a5aa6fc"];
const SHARED_HASH = "14c8c23e8b8dfa874d3fb5a50d54fb28eccf55fb83232c3ab29cb7c0ef0a0472";
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const SHARED_COMPANIONS: Readonly<Record<string, string>> = {
  ".vite/build/src-BSoROW9v.js": "02bfe16d532e9de068979823a2409783b03a10d9b9348e8ad6247ba81aca1e16",
  ".vite/build/src-C9YLnbgY.js": "56f4e7f71fb8e93a022d0378322e8fa723a8da07085138957e722e0ac36e9c9d",
};

/** Check the complete carrier inventory, including on an idempotent recheck. */
export function validateAccountsNativeMainCarriers(sources: ReadonlyMap<string, string>): void {
  const mains = [...sources.keys()].filter(path => /^\.vite\/build\/main-[^/]+\.js$/.test(path));
  if (mains.length !== 1 || mains[0] !== ACCOUNTS_NATIVE_MAIN_PATH) throw new Error("Native Accounts main carrier inventory changed.");
  for (const [path, expected] of Object.entries(SHARED_COMPANIONS)) {
    const source = sources.get(path);
    if (source === undefined || hash(source) !== expected) throw new Error("A reviewed native Accounts companion is missing or changed.");
  }
  for (const [path, source] of sources) {
    if (!/^\.vite\/build\/src-[^/]+\.js$/.test(path) || path === ACCOUNTS_NATIVE_SHARED_PATH) continue;
    if (SHARED_COMPANIONS[path] !== hash(source)) throw new Error("Native Accounts companion inventory changed.");
  }
}

/** Build 9922 bindings; prepare all edits without touching the installed payload. */
export function patchAccountsNativeMainSources(sources: ReadonlyMap<string, string>, hookSetSha256: string): Map<string, string> {
  validateAccountsNativeMainCarriers(sources);
  let main = sources.get(ACCOUNTS_NATIVE_MAIN_PATH);
  let shared = sources.get(ACCOUNTS_NATIVE_SHARED_PATH);
  if (!main || !shared || !MAIN_HASHES.includes(hash(main)) || hash(shared) !== SHARED_HASH) throw new Error("This desktop's native account browser helpers have not been reviewed.");
  if ([...sources].filter(([path, source]) => /^\.vite\/build\/main-[^/]+\.js$/.test(path) && source.includes("async function Fie({appServerConnection:e,")).length !== 1) throw new Error("More than one native account browser helper matched.");
  const edit = (anchor: string, replacement: string) => {
    if (main!.split(anchor).length !== 2) throw new Error("Native account browser helper anchor changed: " + anchor);
    main = main!.replace(anchor, replacement);
  };
  edit('"get-global-state":async({key:e})=>({value:this.getGlobalStateValue(e)})', '"get-global-state":async({key:e})=>{await __twAccountsDesktopProjects.ensure(this,e);return{value:this.getGlobalStateValue(e)}}');
  edit('"workspace-root-options":async({canonicalizeRoots:e,hostId:t,signal:r})=>{let i=', '"workspace-root-options":async({canonicalizeRoots:e,hostId:t,signal:r})=>{if(t===`local`)await __twAccountsDesktopProjects.ensure(this);let i=');
  edit("async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();let r=", "async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();if(await __twAccountsDesktopProjects.ensureBackend(this,t))return;e.throwIfAborted();let r=");
  edit("await f2(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())", "await f2(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),await __twAccountsDesktopProjects.ensureWrite(this),r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())");
  const metadataLock = /async withProjectMetadataLock\((e,t,[a-z])\)\{/g;
  if ([...main!.matchAll(metadataLock)].length !== 1) throw new Error("Native project metadata lock anchor changed.");
  main = main!.replace(metadataLock, (anchor) => anchor + "await __twAccountsDesktopProjects.ensureWrite(this);");
  edit("getInitialSidebarBootstrap(){let e=this.threadCatalogSyncManager;", "getInitialSidebarBootstrap(){void __twAccountsDesktopProjects.ensure(this.fetchHandler).catch(()=>{});let e=this.threadCatalogSyncManager;");
  edit("async function Fie({appServerConnection:e,", "async function Fie({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("g=await So({appServerConnection:e,desktopFeatureAvailability:p,marketplaces:h,", "g=await So({codexHome:__twAccountsHome,appServerConnection:e,desktopFeatureAvailability:p,marketplaces:h,");
  edit("async function So({appServerConnection:e,", "async function So({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("let s=n.yi(),c=n.Dl(a.en.resolve()),l=ui(o)", "let s=__twAccountsHome??n.yi(),c=n.Dl(a.en.resolve()),l=ui(o)");
  const removal = "(i.length!==0||a)&&(c0.info(`chrome_native_host_manifest_remove_requested`";
  if (shared.split(removal).length !== 2) throw new Error("Native browser consumer preservation anchor changed.");
  shared = shared.replace(removal, "if(e.preserveRetainedConsumers===!0)return __twAccountsPreserveNativeConsumers({manifestPaths:i,nativeHostName:t,pluginCacheRoot:r});" + removal);
  shared += `\n;var __twAccountsPreserveNativeConsumers=((__name)=>(input)=>(${preserveNativeBrowserConsumers.toString()})(input,{fs:d.default,path:s,registryPath:t2,readRegistry:G0,parseConsumer:Q0,ownsManifest:C2,write:u2,removeRegistration:V2,description:v0,uid:process.getuid?.(),Buffer}))((fn)=>fn);\n`;
  main += `\n;var __twAccountsDesktopProjects=((__name)=>(${nativeAccountsDesktopProjects.toString()})({enabled:()=>globalThis.__tweakersAccountsDesktopProjectsEnabledV1?.()===true,hostKey:()=>\`local:\${n.yi()}\`,onFocus:(fn)=>l.app.on("browser-window-focus",fn)}))((fn)=>fn);\n`;
  main += `\n;((__name)=>{Object.defineProperty(globalThis,"__tweakersAccountsNativeMainV1",{value:{version:1,hookSetSha256:${JSON.stringify(hookSetSha256)},refreshProjects:()=>__twAccountsDesktopProjects.refresh(),create:(input)=>(${nativeAccountsMainFactory.toString()})(input,{sync:(options)=>new Pie(options).syncAfterPluginChange(),install:(options)=>n.Jt(options),uninstall:(options)=>n.Xt(options),appVersion:l.app.getVersion(),isPackaged:l.app.isPackaged,resourcesPath:process.resourcesPath})},configurable:false,writable:false});})((fn)=>fn);\n`;
  return new Map([[ACCOUNTS_NATIVE_MAIN_PATH, main], [ACCOUNTS_NATIVE_SHARED_PATH, shared]]);
}

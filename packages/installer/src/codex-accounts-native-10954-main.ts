import { createHash } from "node:crypto";
import { nativeAccountsDesktopProjects, preserveNativeBrowserConsumers, nativeAccountsMainFactory } from "./codex-accounts-native-main.js";

export const ACCOUNTS_NATIVE_10954_MAIN_PATH = ".vite/build/main-C-Mhak1n.js";
export const ACCOUNTS_NATIVE_10954_SHARED_PATH = ".vite/build/src-DldfpmrL.js";
// Pristine native bytes, then the same bytes after the installer's earlier window-services patch.
const MAIN_HASHES = [
  "457c79be69620d4489e94c14ac665f81731d869635606dcf175b7b4cc2e8b467",
  "abf2d2aa69d6c6861be45965c47003bb7af9a423208f11e515b717444c28927d",
];
const SHARED_HASH = "88ec69722b5d87a7081edf2e2d6a2e21c3f25300cee587363d74b8b87969a412";
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const SHARED_COMPANIONS: Readonly<Record<string, string>> = {
  ".vite/build/src-BSoROW9v.js": "02bfe16d532e9de068979823a2409783b03a10d9b9348e8ad6247ba81aca1e16",
  ".vite/build/src-C9YLnbgY.js": "56f4e7f71fb8e93a022d0378322e8fa723a8da07085138957e722e0ac36e9c9d",
};

/** Check the complete carrier inventory, including on an idempotent recheck. */
export function validateAccountsNative10954MainCarriers(sources: ReadonlyMap<string, string>): void {
  const mains = [...sources.keys()].filter(path => /^\.vite\/build\/main-[^/]+\.js$/.test(path));
  if (mains.length !== 1 || mains[0] !== ACCOUNTS_NATIVE_10954_MAIN_PATH) throw new Error("Native Accounts main carrier inventory changed.");
  for (const [path, expected] of Object.entries(SHARED_COMPANIONS)) {
    const source = sources.get(path);
    if (source === undefined || hash(source) !== expected) throw new Error("A reviewed native Accounts companion is missing or changed.");
  }
  for (const [path, source] of sources) {
    if (!/^\.vite\/build\/src-[^/]+\.js$/.test(path) || path === ACCOUNTS_NATIVE_10954_SHARED_PATH) continue;
    if (SHARED_COMPANIONS[path] !== hash(source)) throw new Error("Native Accounts companion inventory changed.");
  }
}

/** Reviewed 10954 bindings; prepare all edits without touching the installed payload. */
export function patchAccountsNative10954MainSources(sources: ReadonlyMap<string, string>, hookSetSha256: string): Map<string, string> {
  validateAccountsNative10954MainCarriers(sources);
  let main = sources.get(ACCOUNTS_NATIVE_10954_MAIN_PATH);
  let shared = sources.get(ACCOUNTS_NATIVE_10954_SHARED_PATH);
  if (!main || !shared || !MAIN_HASHES.includes(hash(main)) || hash(shared) !== SHARED_HASH) throw new Error("This desktop's native account browser helpers have not been reviewed.");
  if ([...sources].filter(([path, source]) => /^\.vite\/build\/main-[^/]+\.js$/.test(path) && source.includes("async function Tie({appServerConnection:e,")).length !== 1) throw new Error("More than one native account browser helper matched.");
  const edit = (anchor: string, replacement: string) => {
    if (main!.split(anchor).length !== 2) throw new Error("Native account browser helper anchor changed: " + anchor);
    main = main!.replace(anchor, () => replacement);
  };
  edit('"get-global-state":async({key:e})=>({value:this.getGlobalStateValue(e)})', '"get-global-state":async({key:e})=>{await __twAccountsDesktopProjects.ensure(this,e);return{value:this.getGlobalStateValue(e)}}');
  edit('"workspace-root-options":async({canonicalizeRoots:e,hostId:t,signal:r})=>{let i=', '"workspace-root-options":async({canonicalizeRoots:e,hostId:t,signal:r})=>{if(t===`local`)await __twAccountsDesktopProjects.ensure(this);let i=');
  edit("async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();let r=", "async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();if(await __twAccountsDesktopProjects.ensureBackend(this,t))return;e.throwIfAborted();let r=");
  edit("await d2(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())", "await d2(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),await __twAccountsDesktopProjects.ensureWrite(this),r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())");
  const metadataLock = /async withProjectMetadataLock\((e,t,[a-z])\)\{/g;
  if ([...main!.matchAll(metadataLock)].length !== 1) throw new Error("Native project metadata lock anchor changed.");
  main = main!.replace(metadataLock, (anchor) => anchor + "await __twAccountsDesktopProjects.ensureWrite(this);");
  edit("getInitialSidebarBootstrap(){let e=this.threadCatalogSyncManager;", "getInitialSidebarBootstrap(){void __twAccountsDesktopProjects.ensure(this.fetchHandler).catch(()=>{});let e=this.threadCatalogSyncManager;");
  edit("async function Tie({appServerConnection:e,", "async function Tie({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("g=await Do({appServerConnection:e,desktopFeatureAvailability:p,marketplaces:h,", "g=await Do({codexHome:__twAccountsHome,appServerConnection:e,desktopFeatureAvailability:p,marketplaces:h,");
  edit("async function Do({appServerConnection:e,", "async function Do({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("let s=n.Oi(),c=n.Ul(a.in.resolve()),l=fi(o)", "let s=__twAccountsHome??n.Oi(),c=n.Ul(a.in.resolve()),l=fi(o)");
  const removal = "(i.length!==0||a)&&(R0.info(`chrome_native_host_manifest_remove_requested`";
  if (shared.split(removal).length !== 2) throw new Error("Native browser consumer preservation anchor changed.");
  shared = shared.replace(removal, () => "if(e.preserveRetainedConsumers===!0)return __twAccountsPreserveNativeConsumers({manifestPaths:i,nativeHostName:t,pluginCacheRoot:r});" + removal);
  // 10954 splits the consumer registry into a platform registry (j2) plus a per-home copy; both are
  // written together, so the platform registry remains the complete consumer inventory.
  shared += `\n;var __twAccountsPreserveNativeConsumers=((__name)=>(input)=>(${preserveNativeBrowserConsumers.toString()})(input,{fs:d.default,path:s,registryPath:j2,readRegistry:x2,parseConsumer:O2,ownsManifest:$2,write:B2,removeRegistration:_4,description:J0,uid:process.getuid?.(),Buffer}))((fn)=>fn);\n`;
  main += `\n;var __twAccountsDesktopProjects=((__name)=>(${nativeAccountsDesktopProjects.toString()})({enabled:()=>globalThis.__tweakersAccountsDesktopProjectsEnabledV1?.()===true,hostKey:()=>\`local:\${n.Oi()}\`,onFocus:(fn)=>l.app.on("browser-window-focus",fn)}))((fn)=>fn);\n`;
  main += `\n;((__name)=>{Object.defineProperty(globalThis,"__tweakersAccountsNativeMainV1",{value:{version:1,hookSetSha256:${JSON.stringify(hookSetSha256)},refreshProjects:()=>__twAccountsDesktopProjects.refresh(),create:(input)=>(${nativeAccountsMainFactory.toString()})(input,{sync:(options)=>new wie(options).syncAfterPluginChange(),install:(options)=>n.Jt(options),uninstall:(options)=>n.Xt(options),appVersion:l.app.getVersion(),isPackaged:l.app.isPackaged,resourcesPath:process.resourcesPath})},configurable:false,writable:false});})((fn)=>fn);\n`;
  return new Map([[ACCOUNTS_NATIVE_10954_MAIN_PATH, main], [ACCOUNTS_NATIVE_10954_SHARED_PATH, shared]]);
}

import { createHash } from "node:crypto";
import { nativeAccountsDesktopProjects, preserveNativeBrowserConsumers, nativeAccountsMainFactory } from "./codex-accounts-native-main.js";

export const ACCOUNTS_NATIVE_MAIN_KEY = "__tweakersAccountsNativeMainV1";
export const ACCOUNTS_NATIVE_MAIN_PATH = ".vite/build/main-DaMR-wdT.js";
export const ACCOUNTS_NATIVE_SHARED_PATH = ".vite/build/src-CCXHtyvY.js";
export const ACCOUNTS_NATIVE_MAIN_PATHS = [ACCOUNTS_NATIVE_MAIN_PATH, ACCOUNTS_NATIVE_SHARED_PATH] as const;
const MAIN_HASHES = [
  "0765260be74e8843630d5a92e30bca574783892688e67180c119a5c58679bb61",
  "3e21cb0ddfded1611d1b33a5f6c20c6ce560c8deaa76fd1cec2eec8a51fcb046",
];
const SHARED_HASH = "a42da38cbb14b28399f1d54fcf453bffc5e9802663e7e098f187c8378f4c7a40";
const hash = (source: string): string => createHash("sha256").update(source).digest("hex");

/** Prepare native account-home overrides together with the renderer hooks. */
export function patchAccountsNativeMainSources(sources: ReadonlyMap<string, string>, hookSetSha256: string): Map<string, string> {
  let main = sources.get(ACCOUNTS_NATIVE_MAIN_PATH);
  let shared = sources.get(ACCOUNTS_NATIVE_SHARED_PATH);
  if (!main || !shared || !MAIN_HASHES.includes(hash(main)) || hash(shared) !== SHARED_HASH) {
    throw new Error("This desktop's native account browser helpers have not been reviewed.");
  }
  if ([...sources].filter(([path, source]) => /^\.vite\/build\/main-[^/]+\.js$/.test(path) && source.includes("async function Rre({appServerConnection:e,")).length !== 1) {
    throw new Error("More than one native account browser helper matched.");
  }
  const edit = (anchor: string, replacement: string) => {
    if (main!.split(anchor).length !== 2) throw new Error("Native account browser helper anchor changed.");
    main = main!.replace(anchor, replacement);
  };
  edit("\"get-global-state\":async({key:e})=>({value:this.getGlobalStateValue(e)})",
    "\"get-global-state\":async({key:e})=>{await __twAccountsDesktopProjects.ensure(this,e);return{value:this.getGlobalStateValue(e)}}");
  edit("\"workspace-root-options\":async({canonicalizeRoots:e,hostId:t,signal:r})=>{let i=",
    "\"workspace-root-options\":async({canonicalizeRoots:e,hostId:t,signal:r})=>{if(t===`local`)await __twAccountsDesktopProjects.ensure(this);let i=");
  edit("async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();let r=",
    "async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();await __twAccountsDesktopProjects.ensureBackend(this,t);e.throwIfAborted();let r=");
  edit("await f2(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())",
    "await f2(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),await __twAccountsDesktopProjects.ensureWrite(this),r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())");
  edit("getInitialSidebarBootstrap(){let e=this.threadCatalogSyncManager;",
    "getInitialSidebarBootstrap(){void __twAccountsDesktopProjects.ensure(this.fetchHandler).catch(()=>{});let e=this.threadCatalogSyncManager;");
  edit("async function Rre({appServerConnection:e,", "async function Rre({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("_=await Ha({appServerConnection:e,desktopFeatureAvailability:m,marketplaces:g,", "_=await Ha({codexHome:__twAccountsHome,appServerConnection:e,desktopFeatureAvailability:m,marketplaces:g,");
  edit("async function Ha({appServerConnection:e,", "async function Ha({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("let s=n.Ei(),c=n.El(a.i.resolve()),l=kr(o)", "let s=__twAccountsHome??n.Ei(),c=n.El(a.i.resolve()),l=kr(o)");
  const removalAnchor = "a.length===0&&!o||(fZ.info(`chrome_native_host_manifest_remove_requested`";
  if (shared.split(removalAnchor).length !== 2) throw new Error("Native browser consumer preservation anchor changed.");
  shared = shared.replace(removalAnchor, "if(e.preserveRetainedConsumers===!0)return __twAccountsPreserveNativeConsumers({manifestPaths:a,nativeHostName:t,pluginCacheRoot:r});" + removalAnchor);
  shared += nativeAccountsConsumerPreservationSource();
  main += nativeAccountsDesktopProjectsSource();
  main += nativeAccountsMainRegistrationSource(hookSetSha256);
  return new Map([[ACCOUNTS_NATIVE_MAIN_PATH, main], [ACCOUNTS_NATIVE_SHARED_PATH, shared]]);
}

export function nativeAccountsMainRegistrationSource(hookSetSha256: string): string {
  return `
;((__name)=>{Object.defineProperty(globalThis,${JSON.stringify(ACCOUNTS_NATIVE_MAIN_KEY)},{value:{version:1,hookSetSha256:${JSON.stringify(hookSetSha256)},refreshProjects:()=>__twAccountsDesktopProjects.refresh(),create:(input)=>(${nativeAccountsMainFactory.toString()})(input,{sync:(options)=>new Lre(options).syncAfterPluginChange(),install:(options)=>n.un(options),uninstall:(options)=>n.fn(options),appVersion:l.app.getVersion(),isPackaged:l.app.isPackaged,resourcesPath:process.resourcesPath})},configurable:false,writable:false});})((fn)=>fn);
`;
}

export function nativeAccountsDesktopProjectsSource(): string {
  return `
;var __twAccountsDesktopProjects=((__name)=>(${nativeAccountsDesktopProjects.toString()})({enabled:()=>globalThis.__tweakersAccountsDesktopProjectsEnabledV1?.()===true,hostKey:()=>\`local:\${n.Ei()}\`,onFocus:(fn)=>l.app.on("browser-window-focus",fn)}))((fn)=>fn);
`;
}

/** Build 8881 bindings for the retained-consumer registry and manifest writers. */
function nativeAccountsConsumerPreservationSource(): string {
  return `\n;var __twAccountsPreserveNativeConsumers=((__name)=>(input)=>(${preserveNativeBrowserConsumers.toString()})(input,{fs:l.default,path:i,registryPath:aQ,readRegistry:YZ,parseConsumer:nQ,ownsManifest:DQ,write:mQ,removeRegistration:GQ,description:SZ,uid:process.getuid?.(),Buffer}))((fn)=>fn);\n`;
}

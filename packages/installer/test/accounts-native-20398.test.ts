import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { extractFile, listPackage } from "@electron/asar";
import { parse, parseExpressionAt } from "acorn";
import { ACCOUNTS_NATIVE_REQUIRED_HOOKS, validateAccountsNativeCompatibility } from "@therealityreport/tweakers-sdk";
import { nativeBootstrapSource, patchCodexAccountsNativeSources } from "../src/codex-accounts-native";
import { patchCodexWindowServicesSource } from "../src/codex-window-services";
import { patchCodexInactiveThreadRetentionSource } from "../src/codex-inactive-thread-retention";
import { patchCodexModelSelectionSource } from "../src/codex-model-selection";
import { patchCodexNativeServicePolicySource } from "../src/codex-native-service-policy";
import { patchCodexBillingAnalyticsSource, patchCodexBillingQueriesSource } from "../src/codex-billing-analytics";
import { nativeAccountsRuntimePluginSync, nativeAccountsRuntimeSkillHome } from "../src/codex-accounts-native-20398-main";
const asar = process.env.TWEAKERS_TEST_20398_ASAR ?? join(process.env.HOME ?? "", "Library/Application Support/Tweakers/official-source/baselines/6142fb65-40d4-4092-96dc-439d0ef161e0/resources/app.asar");
const requireFixture = process.env.TWEAKERS_TEST_20398_REQUIRE_FIXTURE === "1";
let fixtureFailure: string | undefined;
try {
  if (!existsSync(asar)) fixtureFailure = `20398 Accounts fixture is missing: ${asar}`;
  else if (!listPackage(asar, { isPack: false }).includes("/webview/assets/app-initial-1ab6fbe93c4f.js")) fixtureFailure = `20398 Accounts fixture has the wrong carrier inventory: ${asar}`;
} catch (error) { fixtureFailure = `20398 Accounts fixture cannot be read: ${asar}: ${String(error)}`; }
const available = fixtureFailure === undefined;
if(requireFixture && !available) throw new Error(`${fixtureFailure}. Set TWEAKERS_TEST_20398_ASAR to the reviewed native build 20398 app.asar; required fixture mode cannot skip acceptance.`);
test("20398 required Accounts fixture is readable and has the reviewed carrier inventory", {skip:!requireFixture}, () => {
  assert.ok(available, `${fixtureFailure}. Set TWEAKERS_TEST_20398_ASAR to the reviewed native build 20398 app.asar; required fixture mode cannot skip acceptance.`);
  assert.equal(patched().record.status, "compatible", patched().record.reason);
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Load the shipped compiled module, typed by its source, so `typecheck:tests` needs no prior build. */
const compiled = <T>(name: string): Promise<T> => import(new URL(`../dist/${name}.js`, import.meta.url).href) as Promise<T>;
let cached: Map<string,string>;
const original = () => cached ??= new Map(listPackage(asar, { isPack: false }).map(p => p.replace(/^\//,""))
  .filter(p => /^webview\/assets\/(app-initial|app-shared|app-primary|profile|plugins-settings|page|mcp-settings|local-conversation-thread|apps-availability)-.*\.js$/.test(p) || /^\.vite\/build\/(main|src|application-network-startup)-.*\.js$/.test(p))
  .map(p => [p,extractFile(asar,p).toString("utf8")]));
let prepared: ReturnType<typeof patchCodexAccountsNativeSources>;
const patched = () => prepared ??= patchCodexAccountsNativeSources(original());
const functions = new Map<string, Map<string,string>>();
function fn(source: string, name: string): string {
  let table = functions.get(source);
  if (!table) {
    table = new Map();
    for (const node of parse(source,{ecmaVersion:"latest",sourceType:"module"}).body) if (node.type === "FunctionDeclaration" && node.id) table.set(node.id.name,source.slice(node.start,node.end));
    functions.set(source,table);
  }
  const result=table.get(name);assert.ok(result,`missing ${name}`);return result;
}
const shared = () => patched().sources.get("webview/assets/app-shared-8340f229c2b3.js")!;
const initial = () => patched().sources.get("webview/assets/app-initial-1ab6fbe93c4f.js")!;
test("20398 runtime sync delegates native definitions while keeping bundle versions and skill homes separate", { skip: !available }, async () => {
  const names = ["documents", "pdf", "presentations", "spreadsheets", "template-creator"];
  for (const scenario of ["native", "legacy", "missing", "withheld", "foreign-home", "aborted", "malformed", "reconnected"] as const) {
    let writes = 0, reports = 0;
    let currentHome = "/owned/execution-home", skillWrites = 0;
    const homes = new WeakMap<object, string>();
    const controller = new AbortController();
    const plugins = names.map(name => ({ id: `${name}@openai-primary-runtime`, installed: true, enabled: false }));
    if (scenario === "missing") plugins.pop();
    if (scenario === "withheld") Object.assign(plugins[0]!, { sharedDefinitionState: "unavailable" });
    const result: any = { marketplaces: [{ name: "openai-primary-runtime", plugins }], marketplaceLoadErrors: [] };
    if (scenario !== "legacy") result.tweakersPluginOwnership = { version: 1, policy: "follow-native", home: "/owned/execution-home",
      plugins: names.map(name => ({ id: `${name}@openai-primary-runtime`, version: "26.1011.11113" })) };
    if (scenario === "malformed") result.tweakersPluginOwnership.policy = "unknown";
    const connection = {
      listPlugins: async (params: any) => { assert.equal(params.tweakersRuntimeOwnership, true); if (scenario === "aborted") controller.abort(); return result; },
      codexHome: async () => scenario === "foreign-home" ? "/native/home" : currentHome,
    };
    const sync = runInNewContext(`(${fn(patched().sources.get(".vite/build/main-CwxgTOle.js")!, "Q2")})`, {
      __twAccountsRuntimePlugins: (e: any, t: any, r: any) => nativeAccountsRuntimePluginSync(e, t, r, {
        enabled: () => true, listParams: {}, readMarketplace: async () => ({ name: "openai-primary-runtime", plugins: names.map(name => ({ name, version: "26.1013.11914" })) }),
        bindHome: (connection: object, home: string) => homes.set(connection, home),
        report: (rows: any[]) => { reports++; assert.ok(rows.every(row => row.version === "26.1011.11113")); },
      }), Cne: async () => { writes++; return true; },
    });
    const work = sync(connection, { bundledPluginMarketplacePaths: ["/runtime/plugins"] }, false, controller.signal);
    if (scenario === "native" || scenario === "legacy" || scenario === "reconnected") {
      await work;
      if (scenario === "reconnected") currentHome = "/native/home";
      const skills = runInNewContext(`(${fn(patched().sources.get(".vite/build/main-CwxgTOle.js")!, "$2")})`, {
        __twAccountsRuntimeSkillHome: (connection: object, home: string) => nativeAccountsRuntimeSkillHome(connection, home, homes),
        gHe: async ({ codexHome }: any) => { assert.equal(codexHome, "/owned/execution-home"); skillWrites++; },
      });
      const migration = skills(connection, { skillsToRemove: ["docs"], bundledSkillPaths: [] }, controller.signal);
      if (scenario === "reconnected") await assert.rejects(migration, /skill home changed/); else await migration;
    } else await assert.rejects(work);
    assert.equal(writes, scenario === "legacy" ? 1 : 0);
    assert.equal(reports, scenario === "native" || scenario === "reconnected" ? 1 : 0);
    assert.equal(skillWrites, scenario === "native" || scenario === "legacy" ? 1 : 0);
  }
});
test("20398 native project Save signals its exact form only after truthy native success", {skip:!available}, async () => {
  assert.equal(patched().record.status, "compatible", patched().record.reason);
  const source = fn(initial(), "D0r");
  let callback: any;
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "AssignmentExpression" && node.left?.name === "O" && node.right?.async) callback = node.right;
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value);
  };
  visit(parse(source, { ecmaVersion: "latest" }));
  assert.ok(callback);
  for (const outcome of [false, true, "throw"]) {
    const events: string[] = [], form = { dispatchEvent: (event: any) => { assert.equal(event.detail.projectId, "project"); events.push(event.type); } };
    const event = { currentTarget: form as unknown, preventDefault() {} };
    const save = runInNewContext(`(${source.slice(callback.start, callback.end)})`, {
      w: false, D: false, T() {}, g: null, a: "before", v: "after", b: [], d: "project", l: () => events.push("close"),
      u: async () => { event.currentTarget = null; if (outcome === "throw") throw Error("fixture"); return outcome; },
      h: { get: () => ({ danger: () => events.push("error") }) }, sc: {}, f: {},
      CustomEvent: class { constructor(public type: string, public detailOptions: any) {} get detail() { return this.detailOptions.detail; } },
    });
    await save(event);
    assert.deepEqual(events, outcome === true ? ["tweaker:project-save-succeeded", "close"] : outcome === "throw" ? ["error"] : []);
  }
});
function bridgeContext() {
  let generation=1,enabled=true;
  const calls:any[]=[];
  const page:any={__tweakersAccountsTransportV1:{initialize:()=>true,status:()=>({compatible:true,enabled}),snapshot:()=>({accountId:"selected",generation}),subscribe:()=>()=>{},request:async (surface:any,method:any,params:any,captured:any)=>{calls.push({surface,method,params,captured});return {status:"ok"};}}};
  runInNewContext(nativeBootstrapSource("a".repeat(64)),page);
  return {page,bridge:page.__tweakersAccountsNativeV1,calls,change:()=>{generation++;},disable:()=>{enabled=false;}};
}

function componentReact() {
  const values:any[]=[];let cursor=0,stateCalls=0,effectCalls=0;
  return {begin:()=>{cursor=0;},counts:()=>({stateCalls,effectCalls}),react:{
    useState:(initial:any)=>{stateCalls++;const index=cursor++;if(!(index in values))values[index]=typeof initial==="function"?initial():initial;return[values[index],(next:any)=>{values[index]=typeof next==="function"?next(values[index]):next;}];},
    useRef:(initial:any)=>{const index=cursor++;return values[index]??= {current:initial};},
    useId:()=>"profile-input",useEffect:()=>{effectCalls++;},useEffectEvent:(callback:any)=>callback,Fragment:"fragment"
  }};
}

/** Execute the complete native component, retaining its local bindings and cache. */
function containingComponent(name:string,component:string,source:string,b:ReturnType<typeof bridgeContext>,loaded=false) {
  const mainReact=componentReact(),slotReact=componentReact(),cache=Array(component==="Yi"?275:258).fill(Symbol.for("react.memo_cache_sentinel"));
  const page:any={...b.page},noop=()=>null;
  // Only module dependencies are replaced. The native function body, including
  // se=P||I||ne and me's scroll callback, is never rewritten by this harness.
  for(const node of parse(source,{ecmaVersion:"latest",sourceType:"module"}).body as any[]) {
    if(node.type==="ImportDeclaration")for(const specifier of node.specifiers)page[specifier.local.name]=noop;
    if(node.type==="FunctionDeclaration"&&node.id)page[node.id.name]=noop;
    if(node.type==="VariableDeclaration")for(const declaration of node.declarations)if(declaration.id.type==="Identifier")page[declaration.id.name]=noop;
  }
  const jsx=(type:any,props:any,key?:any)=>({type,props,key}),empty:any[]=[];
  const account={id:"native",structure:"personal",plan_type:"free"},auth={accountId:"native",userId:"user",authMethod:"apikey",planAtLogin:"free"};
  const events:any[]=[];
  const navigate=(path:any,options:any)=>events.push({kind:"navigate",path,options});
  const scope={},manager={},accountList={accounts:empty};
  const details={username:"native-user",display_name:"Native profile",description:"Saved native bio",photo_frame_style:"circle"};
  const loadedPage={is_self:true,can_edit:true,profile_details:details,page:{workspace_id:"native",visibility:{value:"workspace"},display_settings:{},workspace_display_settings:{}}};
  const intl={formatMessage:(message:any)=>message.defaultMessage},flags={showActivityGraph:false,showUsageStatistics:false,showInsights:false,showTopPlugins:false};
  const mutation={isPending:false,mutateAsync:async(value:any)=>{events.push({kind:"profile-save",value:JSON.parse(JSON.stringify(value))});return value;}},reader={data:null,isLoading:false,isError:false,error:null};
  Object.assign(page,{$:{jsx,jsxs:jsx,Fragment:"fragment"},__tweakersAccountsNativeV1:b.bridge,ta:{c:()=>cache},Dm:{c:()=>cache},na:mainReact.react,Om:mainReact.react,
    // Menu dependencies keep the native sidebar-footer path containing the hook.
    y:()=>scope,s:(key:any)=>key===page.Ur?{isEnabled:false,isLoading:false}:key===page.g?reader:false,ct:()=>auth,Mn:()=>({data:accountList}),Un:()=>({data:account,isError:false}),A:()=>manager,o:()=>false,jt:()=>({data:{plan:"free"}}),$t:()=>({isProfileVisible:false}),Nr:()=>()=>"pricing",Or:()=>({modelSettings:{model:null}}),Je:()=>intl,Mr:()=>empty,Rr:()=>component==="Yi"?{isUsageSettingsVisible:false,isUsageSettingsAccessLoading:false}:empty,jr:()=>noop,be:()=>navigate,ht:()=>{},nn:"general",
    // Native readers are module boundaries; the real profile function and its
    // loaded-state callbacks are executed without rewriting their bodies.
    k:()=>scope,xt:()=>intl,he:()=>false,at:()=>({}),fr:()=>({queryKey:empty}),vn:(callback:any)=>callback,Qr:()=>({data:account}),_a:()=>({avatarOptions:empty}),g:()=>reader,li:()=>"2026-10-10",xi:()=>0,Zi:()=>empty,Se:()=>({petId:null,enabled:false,data:null}),Mi:()=>flags,Ur:()=>reader,sa:()=>mutation,sr:()=>mutation,Kr:()=>mutation,si:()=>({selectedAvatar:{id:"none"}}),rt:{isInternal:()=>false},Xr:()=>false,Ft:flags,no:()=>({pageScope:"workspace"}),oo:()=>true,Er:()=>({summary:{},dailyUsage:empty}),Dr:()=>"circle",ui:(value:any)=>value,Sr:({displayName}:any)=>displayName,lr:(value:any)=>component==="rm"?{localUsername:value}:{data:null},Qt:(...args:any[])=>events.push({kind:"telemetry",args}),H:{CODEX_PROFILE_EDIT_ACTION_DISPLAY_NAME_SAVE_SUCCEEDED:"name-saved",CODEX_PROFILE_EDIT_ACTION_BIO_SAVE_SUCCEEDED:"bio-saved"},V:{},Pn:(...parts:any[])=>parts.filter(Boolean).join(" "),Di:{HeaderToolbar:{Actions:"actions"}}
  });
  // Resolve the real public export before recreating its exact factory binding.
  // PCn is exported from `o`; the internal function named PCn is unrelated.
  const sharedSource=original().get("webview/assets/app-shared-8340f229c2b3.js")!,sharedTree=parse(sharedSource,{ecmaVersion:"latest",sourceType:"module"});
  const exports=sharedTree.body.flatMap((node:any)=>node.type==="ExportNamedDeclaration"?node.specifiers:[]);
  assert.equal(exports.find((node:any)=>node.exported.name==="PCn")?.local.name,"o");
  const factory=(sharedTree.body as any[]).flatMap(node=>node.type==="VariableDeclaration"?node.declarations:[]).find(node=>node.id.name==="o");assert.ok(factory);
  const imported=(parse(source,{ecmaVersion:"latest",sourceType:"module"}).body as any[]).filter(node=>node.type==="ImportDeclaration"&&node.source.value==="./app-shared-8340f229c2b3.js").flatMap(node=>node.specifiers).find(node=>node.local.name==="__twAccountsReact");
  assert.equal(imported?.imported.name,"PCn");
  // Execute the real rolldown CommonJS initializer and both shared factories.
  // Only React's dispatcher is supplied by the harness; the public PCn import
  // resolves through o -> a -> rolldown's exported t without a substitute factory.
  const runtimePath="webview/assets/rolldown-runtime-2d059c5e81f4.js",runtime=extractFile(asar,runtimePath).toString("utf8"),runtimeTree=parse(runtime,{ecmaVersion:"latest",sourceType:"module"});
  const runtimeExport=(runtimeTree.body as any[]).find(node=>node.type==="ExportNamedDeclaration");
  const initializerLocal=runtimeExport.specifiers.find((node:any)=>node.exported.name==="t")?.local.name;assert.ok(initializerLocal);
  const initializerImport=(sharedTree.body as any[]).filter(node=>node.type==="ImportDeclaration"&&node.source.value==="./rolldown-runtime-2d059c5e81f4.js").flatMap(node=>node.specifiers).find(node=>node.local.name==="i");
  assert.equal(initializerImport?.imported.name,"t");
  const reactFactory=(sharedTree.body as any[]).flatMap(node=>node.type==="VariableDeclaration"?node.declarations:[]).find(node=>node.id.name==="a");assert.ok(reactFactory);
  const initialize=runInNewContext(runtime.slice(0,runtimeExport.start)+`;${initializerLocal}`);
  page.__twAccountsReact=runInNewContext(`const ${sharedSource.slice(reactFactory.start,reactFactory.end)},${sharedSource.slice(factory.start,factory.end)};o`,{i:initialize});
  const carrierReact=page.__twAccountsReact();
  carrierReact.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H=slotReact.react;
  assert.equal(carrierReact.version,"19.2.7");assert.equal(page.__twAccountsReact(),carrierReact,"real CommonJS carrier preserves its cached React export");
  const invoke=runInNewContext(`${fn(source,component)};${component}`,page);
  const props=component==="Yi"?{sidebarFooter:{profileIdentity:{displayName:"Native"}},open:true,onClose:()=>events.push({kind:"close-menu"})}:{Layout:"layout",isProfileV2Enabled:true,auth,today:new Date("2026-10-10T12:00:00Z"),presentation:"page",preview:false,onPreviewChange:(value:any)=>events.push({kind:"preview",value}),hasLoggedProfileViewRef:{current:false},shownPageRef:{current:null},visit:{},view:{personal:!loaded,page:loaded?loadedPage:null,profileDetails:loaded?details:null,isLoading:!loaded,isError:false,renderSelector:noop}};
  return {render:()=>{mainReact.begin();return invoke(props);},slotReact,carrierReact,cache,name,props,events};
}
function accountSlots(tree:any):any[] {
  if(!tree||typeof tree!=="object")return[];
  if(Array.isArray(tree))return tree.flatMap(accountSlots);
  if(tree.props?.surface&&typeof tree.type==="function")return[tree];
  return Object.values(tree.props??{}).flatMap(accountSlots);
}

function elements(tree:any):any[] {
  if(!tree||typeof tree!=="object")return[];
  if(Array.isArray(tree))return tree.flatMap(elements);
  return [...(tree.props?[tree]:[]),...Object.values(tree.props??{}).flatMap(elements)];
}
function nativeContent(tree:any):any[] {
  return elements(tree).flatMap(element=>element.props?.surface&&typeof element.type==="function"?elements(element.props.original):[]);
}

for(const [name,component,surface,oldAlias] of [["profile-dropdown-items-4aea5fc452e5.js","Yi","account-menu","se"],["profile-574c8e173ddb.js","rm","profile","me"]]) {
  test(`20398 complete ${component} preserves local bindings, compiler cache and Accounts slot fallback`,{skip:!available},()=>{
    const b=bridgeContext(),source=patched().sources.get("webview/assets/"+name)!,fixture=containingComponent(name,component,source,b);
    const first=accountSlots(fixture.render());assert.equal(first.length,1);assert.equal(first[0].props.surface,surface);assert.equal(first[0].props.context.react,fixture.carrierReact,"the slot uses the dedicated public shared React factory");
    const cached=fixture.cache[component==="Yi"?90:2];assert.equal(typeof cached,"function");const second=accountSlots(fixture.render());assert.equal(second.length,1);assert.equal(fixture.cache[component==="Yi"?90:2],cached,"the containing component retains its native compiler cache");
    if(component==="rm"){assert.equal(typeof cached,"function");const scroll={scrollTop:8},cleanup=cached(scroll);assert.equal(scroll.scrollTop,0);scroll.scrollTop=33;cleanup();cached(scroll);assert.equal(scroll.scrollTop,33,"the native scroll callback remains functional");}
    fixture.slotReact.begin();const before=fixture.slotReact.counts(),active=first[0].type(first[0].props);assert.equal(active.props["data-tweakers-native-surface"],surface);
    assert.equal(fixture.slotReact.counts().stateCalls,before.stateCalls+1);assert.equal(fixture.slotReact.counts().effectCalls,before.effectCalls+1);
    b.disable();fixture.slotReact.begin();assert.equal(first[0].type(first[0].props),first[0].props.original,"disabled Accounts preserves the complete native content");
    const emptyPage:any={};runInNewContext(nativeBootstrapSource("a".repeat(64)),emptyPage);
    const uninitialized=containingComponent(name,component,source,{page:emptyPage,bridge:emptyPage.__tweakersAccountsNativeV1,calls:[],change:()=>{},disable:()=>{}});
    assert.equal(accountSlots(uninitialized.render()).length,0,"absent transport keeps the native component without a slot");
    // Reproduce the previous injection in the same complete native scope. Yi
    // calls a boolean; rm calls its scroll callback and silently loses the slot.
    const broken=source.replace(`react:__twAccountsReact()`,`react:${oldAlias}()`),old=containingComponent(name,component,broken,bridgeContext());
    if(component==="Yi")assert.throws(()=>old.render(),{name:"TypeError"});
    else assert.throws(()=>assert.equal(accountSlots(old.render()).length,1),{name:"AssertionError"});
  });
}

test("20398 loaded profile preserves native inline save, preview and scroll callbacks across reopen and disabled fallback",{skip:!available},async()=>{
  const name="profile-574c8e173ddb.js",b=bridgeContext(),source=patched().sources.get("webview/assets/"+name)!,fixture=containingComponent(name,"rm",source,b,true);
  const firstTree=fixture.render(),first=accountSlots(firstTree);assert.equal(first.length,1);
  const loaded=elements(firstTree),nameField=loaded.find(element=>element.props.field==="displayName"),bioField=loaded.find(element=>element.props.field==="bio");
  assert.ok(nameField,"loaded native profile renders its editable display-name field");assert.ok(bioField,"loaded native profile renders its editable bio field");
  assert.equal(nameField.props.value,"Native profile");assert.equal(bioField.props.value,"Saved native bio");
  await nameField.props.onSave("Updated native name");await bioField.props.onSave("Updated native bio");
  assert.deepEqual(fixture.events.filter(event=>event.kind==="profile-save"),[{kind:"profile-save",value:{displayName:"Updated native name"}},{kind:"profile-save",value:{bio:"Updated native bio"}}]);
  assert.equal(fixture.events.filter(event=>event.kind==="telemetry").length,2);
  const previewButton=elements(firstTree).find(element=>typeof element.props.onClick==="function"&&elements(element.props.children).some(child=>child.props.id==="profile.preview"));assert.ok(previewButton);
  previewButton.props.onClick();assert.deepEqual(fixture.events.at(-1),{kind:"preview",value:true});
  const ownerScroll=fixture.cache[2],scroll={scrollTop:9},ownerCleanup=ownerScroll(scroll);assert.equal(scroll.scrollTop,0);scroll.scrollTop=41;ownerCleanup();
  fixture.props.preview=true;const previewTree=fixture.render();assert.equal(accountSlots(previewTree).length,1);assert.equal(elements(previewTree).some(element=>element.props.field==="bio"),false,"preview is read-only native content");
  const previewScroll=fixture.cache[2],previewCleanup=previewScroll(scroll);assert.equal(scroll.scrollTop,0);scroll.scrollTop=17;previewCleanup();
  const exitPreview=elements(previewTree).find(element=>typeof element.props.onClick==="function"&&elements(element.props.children).some(child=>child.props.id==="profile.preview.exit"));assert.ok(exitPreview);exitPreview.props.onClick();assert.deepEqual(fixture.events.at(-1),{kind:"preview",value:false});
  fixture.props.preview=false;const reopened=accountSlots(fixture.render());assert.equal(reopened.length,1);fixture.cache[2](scroll);assert.equal(scroll.scrollTop,41,"native owner scroll is restored after preview closes");
  b.disable();fixture.slotReact.begin();const fallback=reopened[0].type(reopened[0].props);assert.equal(fallback,reopened[0].props.original);assert.ok(elements(fixture.render()).some(element=>element.props.field==="bio"),"disabled transport retains loaded native fields");
  await elements(fixture.render()).find(element=>element.props.field==="bio").props.onSave("Disabled native bio");assert.deepEqual(fixture.events.filter(event=>event.kind==="profile-save").at(-1),{kind:"profile-save",value:{bio:"Disabled native bio"}});assert.equal(b.calls.length,0,"native profile callbacks do not dispatch through an Accounts transport");
});

test("20398 native account menu callbacks survive close, repeated open and disabled fallback",{skip:!available},()=>{
  const name="profile-dropdown-items-4aea5fc452e5.js",b=bridgeContext(),fixture=containingComponent(name,"Yi",patched().sources.get("webview/assets/"+name)!,b);
  const menu=elements(fixture.render()).find(element=>typeof element.props.onOpenSettings==="function");assert.ok(menu);
  menu.props.onOpenSettings();assert.deepEqual(fixture.events.map(event=>event.kind),["close-menu","navigate"]);assert.equal(fixture.events.at(-1).path,"/settings/general");
  fixture.props.open=false;assert.equal(accountSlots(fixture.render()).length,1);
  fixture.props.open=true;const reopenedTree=fixture.render(),reopenedMenu=elements(reopenedTree).find(element=>typeof element.props.onOpenSettings==="function");assert.ok(reopenedMenu);assert.equal(reopenedMenu.props.onOpenSettings,menu.props.onOpenSettings,"native compiler cache retains callback identity across reopen");
  b.disable();const slot=accountSlots(reopenedTree)[0];fixture.slotReact.begin();assert.equal(slot.type(slot.props),slot.props.original);reopenedMenu.props.onOpenSettings();assert.deepEqual(fixture.events.map(event=>event.kind),["close-menu","navigate","close-menu","navigate"]);assert.equal(b.calls.length,0);
});

test("20398 Accounts authenticates and parses all relocated hooks in the actual installation patch order",{skip:!available},()=>{
  const r=patched();assert.equal(r.record.status,"compatible",r.record.reason);assert.deepEqual(r.record.hooks,[...ACCOUNTS_NATIVE_REQUIRED_HOOKS]);assert.equal(r.record.assets.length,11);
  for(const a of r.record.assets)parse(r.sources.get(a.path)!,{ecmaVersion:"latest",sourceType:a.path.startsWith("webview/")?"module":"script"});
  assert.equal(validateAccountsNativeCompatibility(r.record,p=>r.sources.get(p)!,hash).compatible,true);
  assert.deepEqual(patchCodexAccountsNativeSources(r.sources,r.record).sources,r.sources);
  const ordered=new Map(original()), main=".vite/build/main-CwxgTOle.js";
  ordered.set(main,patchCodexWindowServicesSource(patchCodexNativeServicePolicySource(ordered.get(main)!).source)!.source);
  for(const[p,s]of ordered){const model=p.startsWith("webview/")?patchCodexModelSelectionSource(s)?.source??s:s;ordered.set(p,patchCodexInactiveThreadRetentionSource(model)?.source??model);}
  for(const name of ["billing-analytics-e2b01d494bbf.js","queries-9dd30652911e.js"]){const s=extractFile(asar,"webview/assets/"+name).toString("utf8");ordered.set("webview/assets/"+name,(name.startsWith("queries-")?patchCodexBillingQueriesSource:patchCodexBillingAnalyticsSource)(name,s).source);}
  const combined=patchCodexAccountsNativeSources(ordered);assert.equal(combined.record.status,"compatible",combined.record.reason);
  for(const a of combined.record.assets)parse(combined.sources.get(a.path)!,{ecmaVersion:"latest",sourceType:a.path.startsWith("webview/")?"module":"script"});
});

test("20398 compiled installation composes policy, window, model, retention, Billing, and Accounts with exact native carrier checks",{skip:!available},async()=>{
  const accounts=await compiled<typeof import("../src/codex-accounts-native.js")>("codex-accounts-native"),
    policy=await compiled<typeof import("../src/codex-native-service-policy.js")>("codex-native-service-policy"),
    window=await compiled<typeof import("../src/codex-window-services.js")>("codex-window-services"),
    model=await compiled<typeof import("../src/codex-model-selection.js")>("codex-model-selection"),
    retention=await compiled<typeof import("../src/codex-inactive-thread-retention.js")>("codex-inactive-thread-retention"),
    billing=await compiled<typeof import("../src/codex-billing-analytics.js")>("codex-billing-analytics");
  const ordered=new Map(original()),main=".vite/build/main-CwxgTOle.js";
  ordered.set(main,window.patchCodexWindowServicesSource(policy.patchCodexNativeServicePolicySource(ordered.get(main)!).source)!.source);
  assert.equal(hash(ordered.get(main)!),"70a5e142d90356580709a3f023cfe86c993e7114d53c1a9ff153c12bcb5a153c");
  for(const[p,s]of ordered){const adjusted=p.startsWith("webview/")?model.patchCodexModelSelectionSource(s)?.source??s:s;ordered.set(p,retention.patchCodexInactiveThreadRetentionSource(adjusted)?.source??adjusted);}
  for(const name of ["billing-analytics-e2b01d494bbf.js","queries-9dd30652911e.js"]){const s=extractFile(asar,"webview/assets/"+name).toString("utf8");ordered.set("webview/assets/"+name,(name.startsWith("queries-")?billing.patchCodexBillingQueriesSource:billing.patchCodexBillingAnalyticsSource)(name,s).source);}
  const r=accounts.patchCodexAccountsNativeSources(ordered);assert.equal(r.record.status,"compatible",r.record.reason);
  assert.equal(validateAccountsNativeCompatibility(r.record,p=>r.sources.get(p)!,hash).compatible,true);
  for(const a of r.record.assets)parse(r.sources.get(a.path)!,{ecmaVersion:"latest",sourceType:a.path.startsWith("webview/")?"module":"script"});
  const drift=new Map(ordered);drift.set(main,ordered.get(main)!+"\n");assert.equal(accounts.patchCodexAccountsNativeSources(drift).record.status,"unavailable");
});

test("20398 deployed sealed Manager composes the full installation order with exact native carrier checks",{skip:!available},async()=>{
  const bundlePath=join(import.meta.dirname,"../assets/manager-launcher/manager.mjs"),bundle=readFileSync(bundlePath,"utf8");
  const tree=parse(bundle,{ecmaVersion:"latest",sourceType:"module"});
  const entry=tree.body.filter((node:any)=>node.type==="IfStatement"&&node.test.type==="CallExpression"&&node.test.callee.type==="Identifier"&&node.test.callee.name==="isDirectExecution");
  assert.equal(entry.length,1,"The sealed Manager must have exactly one CLI invocation boundary");
  assert.equal(/managed-mcp-canary-adjudicator\.(?:ts|js)$/.test(process.argv[1]??""),false,"The pure patch facade must never use a canary CLI entrypoint");
  // Import a pure patch facade, never the Manager CLI. Preserve the exact
  // generated function bodies that .toString() installs in the candidate.
  const edits:Array<{start:number,end:number,value:string}>=[{start:entry[0].start,end:entry[0].end,value:""}];
  const visit=(node:any)=>{if(!node||typeof node!=="object")return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==="MemberExpression"&&node.object.type==="MetaProperty"&&node.object.meta.name==="import"&&node.property.type==="Identifier"&&node.property.name==="url")edits.push({start:node.start,end:node.end,value:JSON.stringify(pathToFileURL(bundlePath).href)});
    Object.values(node).forEach(visit);};visit(tree);
  let facade=bundle;for(const e of edits.sort((a,b)=>b.start-a.start))if(e.start<entry[0].start||e.start>=entry[0].end||e===edits.find(x=>x.value===""))facade=facade.slice(0,e.start)+e.value+facade.slice(e.end);
  facade+="\ninit_codex_native_service_policy();init_codex_window_services();init_codex_model_selection();init_codex_inactive_thread_retention();init_codex_accounts_native();init_codex_billing_analytics();\nexport {patchCodexNativeServicePolicySource,patchCodexWindowServicesSource,patchCodexModelSelectionSource,patchCodexInactiveThreadRetentionSource,patchCodexBillingAnalyticsSource,patchCodexBillingQueriesSource,patchCodexAccountsNativeSources};\n";
  const p=await import("data:text/javascript;base64,"+Buffer.from(facade).toString("base64")).catch((error:unknown)=>{throw new Error("Unable to import sealed patch facade: "+String((error as Error).message).replace(/data:text\/javascript;base64,\S+/g,"[sealed patch facade]").slice(0,500));});
  const ordered=new Map(original()),main=".vite/build/main-CwxgTOle.js";
  ordered.set(main,p.patchCodexWindowServicesSource(p.patchCodexNativeServicePolicySource(ordered.get(main)!).source)!.source);
  assert.equal(hash(ordered.get(main)!),"be30f34d97e6cbc55b1e31ac8b51a7f0b0d5bd449cf64383cf7c92e1a5565c85");
  for(const[path,s]of ordered){const adjusted=path.startsWith("webview/")?p.patchCodexModelSelectionSource(s)?.source??s:s;ordered.set(path,p.patchCodexInactiveThreadRetentionSource(adjusted)?.source??adjusted);}
  for(const name of ["billing-analytics-e2b01d494bbf.js","queries-9dd30652911e.js"]){const s=extractFile(asar,"webview/assets/"+name).toString("utf8");ordered.set("webview/assets/"+name,(name.startsWith("queries-")?p.patchCodexBillingQueriesSource:p.patchCodexBillingAnalyticsSource)(name,s).source);}
  const r=p.patchCodexAccountsNativeSources(ordered);assert.equal(r.record.status,"compatible",r.record.reason);
  assert.equal(validateAccountsNativeCompatibility(r.record,(path:string)=>r.sources.get(path)!,hash).compatible,true);
  for(const a of r.record.assets)parse(r.sources.get(a.path)!,{ecmaVersion:"latest",sourceType:a.path.startsWith("webview/")?"module":"script"});
  assert.deepEqual(p.patchCodexAccountsNativeSources(r.sources,r.record).sources,r.sources);
  const drift=new Map(ordered);drift.set(main,ordered.get(main)!+"\n");const refused=p.patchCodexAccountsNativeSources(drift);assert.equal(refused.record.status,"unavailable");assert.deepEqual(refused.sources,drift);
});

test("20398 refuses missing, altered, duplicate, and changed idempotent carriers without partial edits",{skip:!available},()=>{
  for(const path of ["webview/assets/profile-dropdown-items-4aea5fc452e5.js","webview/assets/profile-settings-4103fed8dc14.js",".vite/build/src-CP7XXlpZ.js",".vite/build/application-network-startup-YSC7OAs0.js"]){
    const drift=new Map(original());drift.set(path,drift.get(path)!+"\n");const r=patchCodexAccountsNativeSources(drift);assert.equal(r.record.status,"unavailable");assert.deepEqual(r.sources,drift);
    const missing=new Map(original());missing.delete(path);assert.equal(patchCodexAccountsNativeSources(missing).record.status,"unavailable");
  }
  for(const path of ["webview/assets/profile-ffffffffffff.js","webview/assets/page-ffffffffffff.js",".vite/build/main-duplicate.js"]){const duplicate=new Map(original());duplicate.set(path,"duplicate");assert.equal(patchCodexAccountsNativeSources(duplicate).record.status,"unavailable");}
  const r=patched(),drift=new Map(r.sources);drift.set(r.record.assets[0].path,drift.get(r.record.assets[0].path)!+"\n");assert.equal(patchCodexAccountsNativeSources(drift,r.record).record.status,"unavailable");
  const incomplete={...r.record,assets:r.record.assets.slice(1)};assert.equal(validateAccountsNativeCompatibility(incomplete,p=>r.sources.get(p)!,hash).compatible,false);
});

test("20398 completed native builtin builder invokes main attestation before renderer composition", {skip:!available}, async () => {
  assert.equal(patched().record.status, "compatible", patched().record.reason);
  const main = patched().sources.get(".vite/build/main-CwxgTOle.js")!;
  const start = main.indexOf("async buildMcpCodexConfig(e){"), end = main.indexOf("async readCodexHome(e){", start);
  assert.ok(start >= 0 && end > start);
  const calls: unknown[] = [];
  const page: any = { l: { h: "local" }, Qc() {}, K: () => ({}), g: { ft: () => "fixture" }, _: { app: { isPackaged: true } }, process: { resourcesPath: "/resources" },
    zc: async () => ({ "mcp_servers.node_repl": { command: "/native/repl" }, "mcp_servers.cua_repl": { enabled: false, command: "/native/desktop" } }),
    S_e: async () => ({ "mcp_servers.openai_artifact_template_picker": { command: "/native/picker" } }),
    ba: () => ({ "mcp_servers.artifact_session": { command: "/native/artifacts" } }), vl: async () => ({ "mcp_servers.codex_app.enabled": true }),
    __tweakersAttestNativeDesktopConfigV1: (config: unknown) => { calls.push(config); return { ...(config as object), proof: "fixture" }; } };
  const build = runInNewContext(`({${main.slice(start, end)}}).buildMcpCodexConfig`, page);
  const owner = { appServerConnectionRegistry: { getConnection: () => ({ hostConfig: {}, appServerVersion: "fixture" }) }, getSettingsStore() {}, shouldUseWslPaths: () => false, getArtifactSessionHostLifecycle() {} };
  const result = await build.call(owner, "/workspace");
  assert.equal(calls.length, 1); assert.equal(Object.keys(calls[0] as object).length, 5); assert.equal(result.proof, "fixture");
});

test("20398 local automation attests its completed native tools and leaves remote construction unchanged", {skip:!available}, async () => {
  assert.equal(patched().record.status, "compatible", patched().record.reason);
  const main = patched().sources.get(".vite/build/main-CwxgTOle.js")!;
  const anchor = "ne=async e=>{let n=p.hostConfig;Qc({settingsStore:f,isPackaged:x,repoRoot:S});";
  assert.equal(main.split(anchor).length, 2);
  const start = main.indexOf(anchor) + 3, expression = parseExpressionAt(main, start, { ecmaVersion: "latest" });
  const node = expression.type === "SequenceExpression" ? expression.expressions[0]! : expression;
  for (const kind of ["local", "ssh"]) {
    let attestations = 0;
    const page: any = { p: { hostConfig: { kind } }, Qc() {}, f: {}, x: true, S: "/repo", t: "fixture", s: {}, c: { yt: () => false },
      zc: async () => ({ "mcp_servers.node_repl": { command: "/native/repl" } }), vl: async () => ({}), _: { model: "selected" },
      I: { sandboxPolicy: { type: "dangerFullAccess" } }, te: "instructions", r: { hr: () => 'plugins."codex-app-tools@openai-bundled".mcp_servers.codex_app.enabled_tools' }, v: ["allowed"],
      o: { appServerVersion: "fixture", startThread: async (params: any) => params },
      __tweakersAttestNativeDesktopConfigV1: (config: any) => { attestations++; return { ...config, proof: "fixture" }; } };
    const run = runInNewContext(`(${main.slice(start, node.end)})`, page);
    const result = await run("/workspace");
    assert.equal(attestations, kind === "local" ? 1 : 0);
    assert.equal(result.config["mcp_servers.node_repl"].command, "/native/repl");
    assert.deepEqual(Array.from(result.config['plugins."codex-app-tools@openai-bundled".mcp_servers.codex_app.enabled_tools']), ["allowed"]);
  }
});

test("20398 native browser selection uses the supplied account home and preserves native fallback",{skip:!available},async()=>{
  const main=patched().sources.get(".vite/build/main-CwxgTOle.js")!;
  const page:any={c:{ot:()=>"/native"},r:{$o:()=>"market",zo:"browser"},p:{t:{resolve:()=>"/app"}},oa:()=>({platform:"darwin"}),Ra:()=>null,Qa:()=>false,$a:()=>({serviceAppPath:null}),Xne:()=>false,Rs:()=>{}};
  const select=runInNewContext(`${fn(main,"Ls")};Ls`,page);
  const options={appServerConnection:{},desktopFeatureAvailability:{},marketplaces:[]};
  assert.equal((await select({...options,codexHome:"/selected"})).codexHome,"/selected");
  assert.equal((await select(options)).codexHome,"/native");
});

test("20398 actual project startup returns before saved-mode imports, deletions and state writes", { skip: !available }, async () => {
  const main = patched().sources.get(".vite/build/main-CwxgTOle.js")!;
  const start = main.indexOf("async initializeProjects(e){"), end = main.indexOf("async listProjects(e){", start);
  assert.ok(start >= 0 && end > start);
  let saved = true, reads = 0;
  const page: any = { __twAccountsDesktopProjects: { ensureBackend: async (_backend: any, home: string) => { assert.equal(home, "/bound"); return saved; } }, r: { Ti: () => false } };
  const initialize = runInNewContext(`({${main.slice(start, end)}}).initializeProjects`, page);
  const signal = { throwIfAborted: () => {} };
  const backend: any = { pendingProjectWrites: new Map(), connection: { codexHome: async () => "/bound", appServerVersion: "0.153.4" }, cache: { hostId: "local" },
    pendingDeletions: { getAll: () => { reads++; throw Error("saved startup must not consume deletions"); } } };
  await initialize.call(backend, signal);
  assert.equal(reads, 0);
  assert.equal(backend.migrationIdentity, undefined, "the saved hook precedes native initialization authority");
  saved = false;
  backend.pendingDeletions.getAll = () => { reads++; return {}; };
  await initialize.call(backend, signal);
  assert.equal(reads, 1, "authenticated mode retains native initialization");
  assert.equal(backend.migrationIdentity, "local:/bound");
});

test("20398 metadata mutation rejects saved authority before constructing a lock", { skip: !available }, async () => {
  const main = patched().sources.get(".vite/build/main-CwxgTOle.js")!;
  const start = main.indexOf("async withProjectMetadataLock(e,t,n){"), end = main.indexOf("setThreadAssignmentsEnabled(e){", start);
  assert.ok(start >= 0 && end > start);
  let callbacks = 0;
  const lock = runInNewContext(`({${main.slice(start, end)}}).withProjectMetadataLock`, {
    __twAccountsDesktopProjects: { ensureWrite: async () => { throw Error("Saved projects are read-only"); } },
    R: { createHash: () => { throw Error("lock path must not be constructed"); } },
  });
  await assert.rejects(lock.call({}, "project", { throwIfAborted: () => {} }, () => { callbacks++; }), /read-only/);
  assert.equal(callbacks, 0);
});

test("20398 native profile statistics retain native identity with enabled and disabled Accounts", { skip: !available }, async () => {
  const b = bridgeContext();
  const native = { profile: { display_name: "Admin", username: "admin", profile_picture_url: "https://example.invalid/admin.png" },
    stats: { daily_usage_buckets: null, lifetime_tokens: 3 }, metadata: { stats_error: null } };
  let reads = 0, overlays = 0;
  b.page.__tweakersAccountsTransportV1.request = async (surface: string, method: string, params: any) => {
    assert.equal(surface, "profile"); assert.equal(method, "profile.statistics");
    assert.strictEqual(params.native, native);
    overlays++;
    return { ...native, stats: { ...native.stats, lifetime_tokens: 77 } };
  };
  const read = runInNewContext(`${fn(initial(), "U9i")};U9i`, { ...b.page, __tweakersAccountsNativeV1: b.bridge,
    Zl: { safeGet: async (url: string) => { assert.equal(url, "/wham/profiles/me"); reads++; return native; } }, Y7i: () => null });
  const selected = await read();
  assert.equal(selected.displayName, "Admin"); assert.equal(selected.username, "admin");
  assert.equal(selected.imageUrl, native.profile.profile_picture_url); assert.equal(selected.summary.totalTextTokens, 77);
  b.disable();
  const disabled = await read();
  assert.equal(disabled.displayName, "Admin"); assert.equal(disabled.imageUrl, native.profile.profile_picture_url);
  assert.equal(disabled.summary.totalTextTokens, 3); assert.equal(reads, 2); assert.equal(overlays, 1);
  assert.equal(native.stats.lifetime_tokens, 3);
});

test("20398 MCP edit captures the selected account and rejects callbacks after a selection change",{skip:!available},async()=>{
  const b=bridgeContext();let callback:any, capturedVariables:any;let callbacks=0;
  const page:any={...b.page,__tweakersAccountsNativeV1:b.bridge,Kq:{c:()=>Array(9).fill(Symbol())},hA:()=>({}),X:{},JG:()=>async()=>{},GP:(options:any)=>({mutateAsync:(variables:any)=>{callback=options;capturedVariables=variables;return options.mutationFn(variables);}}),Yjn:()=>{},Qjn:async()=>{callbacks++;},KI:()=>{throw Error("native transport must not run")}};
  const hook=runInNewContext(`${fn(shared(),"Jjn")};Jjn`,page);
  await hook({hostId:"local"}).mutateAsync({filePath:null,key:"test",value:{enabled:true}});
  assert.equal(b.calls.length,1);assert.equal(b.calls[0].surface,"mcp");assert.equal(b.calls[0].method,"config/batchWrite");
  await callback.onSuccess({},capturedVariables);assert.equal(callbacks,1);b.change();await callback.onSuccess({},capturedVariables);assert.equal(callbacks,1,"stale completion must not invalidate the newly selected account");
});

test("20398 captured connector flows reject new unsupported variants and preserve native fallback",{skip:!available},async()=>{
  const b=bridgeContext();let fallback=0;const page:any={...b.page,__tweakersAccountsNativeV1:b.bridge,aqr:()=>null,Xqr:()=>"API_KEY",qqr:()=>false,nJr:()=>{fallback++;return{kind:"browser-fallback"}},zf:{error:()=>{}},crypto:{randomUUID:()=>"id"}};
  const connect=runInNewContext(`${fn(shared(),"Rqr")};Rqr`,page);
  const base={scope:{},app:{id:"app"},connector:{id:"app"},queryClient:{}};
  assert.equal((await connect({...base,serviceAccountId:"service"})).kind,"failed");
  assert.equal((await connect({...base,startOAuth:()=>{throw Error("must not run")}})).kind,"failed");
  assert.equal((await connect(base)).kind,"failed");assert.equal(fallback,0);
  b.disable();page.Xqr=()=>"UNSUPPORTED";assert.equal((await connect(base)).kind,"browser-fallback");assert.equal(fallback,1);
});

test("20398 reset consume rejects an uncaptured mutation and uses the scoped transport",{skip:!available},async()=>{
  const b=bridgeContext(),consume=runInNewContext(`${fn(initial(),"KRr")};KRr`,{...b.page,__tweakersAccountsNativeV1:b.bridge,Zl:{safePost:()=>{throw Error("wrong native account")}}});
  await assert.rejects(async()=>consume({creditId:"credit",redeemRequestId:"redeem"}),{name:"AbortError"});
  const handle=b.bridge.mutationHandle("usage",{mutateAsync:consume});await handle.mutateAsync({creditId:"credit",redeemRequestId:"redeem"});assert.equal(b.calls[0].method,"usage.credits.consume");
});

test("20398 MCP completion stops between awaited invalidations when the account changes",{skip:!available},async()=>{
  const b=bridgeContext(), calls:any[]=[];let release!:()=>void;
  const paused=new Promise<void>(resolve=>{release=resolve;});
  const page:any={...b.page,__tweakersAccountsNativeV1:b.bridge,Yq:["mcp"],qq:["config","mcp","servers"],Xq:["mcp","resources"]};
  const invalidate=async(key:any)=>{calls.push(key);if(calls.length===1)await paused;};
  const finish=runInNewContext(`${fn(shared(),"Qjn")};Qjn`,page);
  const pending=finish("local",invalidate,b.bridge.capture("mcp"));
  await Promise.resolve();assert.equal(calls.length,1);b.change();release();await assert.rejects(pending,{name:"AbortError"});assert.equal(calls.length,1);
});

test("20398 OAuth continuation cannot write caches after a selection change during telemetry",{skip:!available},async()=>{
  const b=bridgeContext();let release!:()=>void, telemetryStarted!:()=>void;
  const paused=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{telemetryStarted=resolve;});
  let writes=0;const pending:any={appId:"app",appName:"App",hostId:"local",oauthState:"oauth",diagnosticId:"id",claimed:true,completed:false,accountId:"native",resumeTarget:{kind:"apps-tab"}};
  const atoms=new Map<any,any>();const Nh={},dA={},$An={},Pg={};atoms.set(Nh,"native");atoms.set(dA,{oauth:pending});atoms.set($An,{});
  const scope={get:(key:any)=>atoms.get(key),set:(key:any,value:any)=>{writes++;atoms.set(key,typeof value==="function"?value(atoms.get(key)):value);}};
  const queries={setQueryData:()=>{writes++;},invalidateQueries:async()=>{writes++;},getQueryData:()=>undefined};
  const page:any={...b.page,__tweakersAccountsNativeV1:b.bridge,WAn:{c:()=>Array(10).fill(Symbol())},GAn:{useContext:()=>({accountId:"native",userId:"user"})},S1e:{},Oi:()=>scope,q:{},ku:()=>queries,Gc:()=>async()=>{},vAn:()=>({claimAppConnectOAuthCallback:()=>true,clearPendingAppConnect:()=>{},getPendingAppConnectForCallbackUrl:()=>pending,markAppConnectOAuthCallbackCompleted:()=>{},releaseAppConnectOAuthCallbackClaim:()=>{}}),performance:{timeOrigin:0,now:()=>0},Uc:()=>false,w$e:()=>undefined,Mp:()=>false,NAn:()=>"oauth",Nh,dA,$An,Pg,aA:()=>{},uA:new Set(),AAn:()=>null,nAn:()=>false,QC:()=>{},Zl:{safePost:async()=>({link:{id:"link",connector_id:"app",name:"App"}})},nZe:"sku",Wwe:()=>"CODEX",WYe:()=>null,VAn:()=>{telemetryStarted();return paused;},C_e:{},Xfe:{},hDe:()=>{},KSe:{},Op:()=>{},zbe:{},Nle:{},yGe:{},gr:{error:()=>{},warning:()=>{}},ime:()=>null,$e:class{},Zi:class{},DAn:()=>{}};
  // Keep HTTP outside this isolated test: the tested callback starts with an
  // already authenticated response, then pauses its real native telemetry.
  page.__tweakersAccountsNativeV1={...b.bridge,http:()=>async()=>({link:{id:"link",connector_id:"app",name:"App"}})};
  const hook=runInNewContext(`${fn(initial(),"EAn")};EAn`,page), callback=hook();
  const result=callback({fullRedirectUrl:"https://callback/?state=oauth",hasCallbackClaim:true});await started;const before=writes;b.change();release();await result;assert.equal(writes,before,"no postawait native cache or resume writes");
});


test("20398 captured OAuth refuses native resume variants before HTTP and leaves native fallback available",{skip:!available},async()=>{
  for(const kind of ["mcp-connect-sheet","chatgpt-tool-request","chatgpt-pca-beacon","connector-auth-elicitation","tool-suggestion-elicitation","plugin-install","plugin-skill","service-account","apps-tab"]){
    const b=bridgeContext();let requests=0;const Nh={},dA={};
    const pending:any={accountId:"native",appId:"app",oauthState:"oauth",resumeTarget:{kind},...(kind==="apps-tab"?{pluginInstallOAuthState:"install"}:{})};
    const page:any={...b.page,__tweakersAccountsNativeV1:b.bridge,WAn:{c:()=>Array(10).fill(Symbol())},GAn:{useContext:()=>({accountId:"native"})},S1e:{},Oi:()=>({get:(key:any)=>key===Nh?"native":key===dA?{oauth:pending}:undefined}),q:{},ku:()=>({}),Gc:()=>()=>{},vAn:()=>({claimAppConnectOAuthCallback:()=>true,clearPendingAppConnect:()=>{},getPendingAppConnectForCallbackUrl:()=>pending,markAppConnectOAuthCallbackCompleted:()=>{},releaseAppConnectOAuthCallbackClaim:()=>{}}),performance:{timeOrigin:0,now:()=>0},Uc:()=>false,w$e:()=>undefined,Mp:()=>false,NAn:()=>"oauth",Nh,dA,uA:new Set(),Zl:{safePost:()=>{requests++;return new Promise(()=>{});}},AAn:()=>null,nAn:()=>false,nZe:"sku",Wwe:()=>"CODEX",QC:()=>{}};
    const callback=runInNewContext(`${fn(initial(),"EAn")};EAn`,page)();
    assert.equal((await callback({fullRedirectUrl:"callback",hasCallbackClaim:true})).kind,"request-failed",kind);assert.equal(requests,0);assert.equal(b.calls.length,0);
    // Reaching the original native HTTP request proves the early refusal applies
    // only to a captured Tweakers selection. The pending promise performs no work.
    b.disable();callback({fullRedirectUrl:"callback",hasCallbackClaim:true});await Promise.resolve();await Promise.resolve();assert.equal(requests,1,kind+" native fallback");
  }
});

test("20398 Apps refresh keeps the original capture across pages, chunks, and its final cache write",{skip:!available},async()=>{
  for(const installed of [false,true]){
    const b=bridgeContext();let release!:(value:any)=>void;const paused=new Promise(resolve=>{release=resolve;});let dispatches=0;
    const page:any={...b.page,__tweakersAccountsNativeV1:{...b.bridge,capturedRpc:(captured:any)=>{b.bridge.ensure(captured);dispatches++;return paused;}},NKt:({apps}:any)=>apps,UIe:({request}:any)=>request(),Dg:()=>{throw Error("must not route through current native account")},eGt:50,tGt:50,$Wt:{default:(values:any)=>[values]},Ih:()=>false,gr:{error:()=>{}}};
    const read=runInNewContext(`${fn(initial(),"QWt")};${fn(initial(),"OKt")};OKt`,page);
    const result=read({scope:{},hostId:"local",shouldUseNewAppLifecycle:installed,accountsCapture:b.bridge.capture("apps")});await Promise.resolve();assert.equal(dispatches,1);b.change();release(installed?{apps:[{id:"app"}]}:{data:[],nextCursor:"page2"});await assert.rejects(result,{name:"AbortError"});assert.equal(dispatches,1);
  }
  const b=bridgeContext();let release!:(value:any)=>void;const paused=new Promise(resolve=>{release=resolve;});let writes=0;
  const refresh=runInNewContext(`${fn(initial(),"mKt")};mKt`,{...b.page,__tweakersAccountsNativeV1:b.bridge,rw:(h:any)=>h,$C:()=>false,Nh:{},OKt:()=>paused,iw:()=>["apps"]});
  const result=refresh({scope:{get:()=>"native"},hostId:"local",queryClient:{setQueryData:()=>{writes++;}},accountsCapture:b.bridge.capture("apps")});b.change();release([]);await assert.rejects(result,{name:"AbortError"});assert.equal(writes,0);
});

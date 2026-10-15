import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertRuntimeRepairBundledSourceDelta, assertRuntimeRepairSourceCheckReceipt, runtimeRepairCompilerMapInputs,
  RUNTIME_REPAIR_FIXED_CHECKS, runtimeRepairSourceInputIdentity, runtimeRepairDependencyIdentity, collectRuntimeRepairSourceInputs,
  runtimeRepairSourceCheckCache, runtimeRepairSourceEnvironmentIdentity, stageRuntimeRepairSourceCustody, reviewRuntimeRepairGeneratedDelta, readRuntimeRepairSourceCustody } from "../src/runtime-repair-source-custody.js";

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const bundle = (sources: string[], sourcesContent: string[]): Buffer => Buffer.from(`module.exports={};\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({version:3,sources,sourcesContent,names:[],mappings:""})).toString("base64")}\n`);

test("accepted runtime repair dependency identity binds the consumed emitted SDK generation and resolution", () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"repair-sdk-input-"))); chmodSync(root,0o700);
  try {
    const sdk=join(root,"packages/sdk"), dist=join(sdk,"dist");
    mkdirSync(dist,{recursive:true,mode:0o700}); mkdirSync(join(root,"node_modules/@therealityreport"),{recursive:true,mode:0o700});
    symlinkSync("../../packages/sdk",join(root,"node_modules/@therealityreport/tweakers-sdk"));
    const packageRecord={name:"@therealityreport/tweakers-sdk",main:"dist/index.js",types:"dist/index.d.ts"};
    writeFileSync(join(sdk,"package.json"),JSON.stringify(packageRecord),{mode:0o600});
    writeFileSync(join(dist,"index.js"),"export const value=1;",{mode:0o600});
    writeFileSync(join(dist,"index.d.ts"),"export declare const value: 1;",{mode:0o600});
    const before=runtimeRepairDependencyIdentity(root);
    writeFileSync(join(dist,"index.js"),"export const value=2;");
    assert.notEqual(runtimeRepairDependencyIdentity(root),before,"unchanged SDK sources cannot hide changed consumed JS");
    writeFileSync(join(dist,"index.js"),"export const value=1;");
    assert.equal(runtimeRepairDependencyIdentity(root),before);
    writeFileSync(join(dist,"index.d.ts"),"export declare const value: 2;");
    assert.notEqual(runtimeRepairDependencyIdentity(root),before,"consumed declarations are prerequisites too");
    writeFileSync(join(sdk,"package.json"),JSON.stringify({...packageRecord,main:"dist/other.js"}));
    assert.throws(()=>runtimeRepairDependencyIdentity(root),/SDK package entry resolution changed/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("accepted runtime repair compiler maps resolve standard tsc sources without sourcesContent", () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"repair-map-"))); chmodSync(root,0o700);
  try {
    const source=join(root,"packages/runtime/src/main.ts"), output=join(root,"packages/runtime/dist/main.js");
    mkdirSync(join(root,"packages/runtime/src"),{recursive:true}); mkdirSync(join(root,"packages/runtime/dist"));
    writeFileSync(source,"export const init = 1;",{mode:0o600});
    const files=[{relativePath:"packages/runtime/src/main.ts",mode:0o600,sha256:sha("export const init = 1;")}];
    const map={version:3,sources:["../src/main.ts"],names:[],mappings:""};
    assert.deepEqual(runtimeRepairCompilerMapInputs(root,output,Buffer.from(JSON.stringify(map)),files),[{relativeSourcePath:files[0]!.relativePath,sha256:files[0]!.sha256}]);
    assert.throws(()=>runtimeRepairCompilerMapInputs(root,output,Buffer.from(JSON.stringify({...map,sourcesContent:["stale"]})),files),/sourcesContent/);
    assert.throws(()=>runtimeRepairCompilerMapInputs(root,output,Buffer.from(JSON.stringify({...map,sources:["../../../../foreign.ts"]})),files),/foreign|unresolved/);
    writeFileSync(source,"changed");
    assert.throws(()=>runtimeRepairCompilerMapInputs(root,output,Buffer.from(JSON.stringify(map)),files),/stale map source/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("accepted runtime repair bundle grant cannot cover an unrelated input beside an approved main", () => {
  const sources=["../src/main.ts","../src/account-router/shared-native-mode.ts"];
  const before=bundle(sources,["old main","unchanged resolver"]);
  assert.doesNotThrow(()=>assertRuntimeRepairBundledSourceDelta(before,bundle(sources,["new main","unchanged resolver"]),"packages/installer/assets/runtime/main.js"));
  assert.throws(()=>assertRuntimeRepairBundledSourceDelta(before,bundle(sources,["new main","changed resolver"]),"packages/installer/assets/runtime/main.js"),/unreviewed bundled source change/);
  assert.throws(()=>assertRuntimeRepairBundledSourceDelta(before,bundle([sources[0]!],["new main"]),"packages/installer/assets/runtime/main.js"),/unreviewed bundled source change/);
});

test("accepted runtime repair check receipt requires every fixed command cwd and observed input snapshot", () => {
  const run="11111111-1111-4111-8111-111111111111", files=[{relativePath:"packages/runtime/src/main.ts",mode:0o600,sha256:"a".repeat(64)}];
  const value={version:1,kind:"tweakers-runtime-repair-source-checks",checkoutRoot:"/fixed-checkout",sourceFiles:files,
    inputIdentity:runtimeRepairSourceInputIdentity(files),node:{path:"/fixed-node",sha256:"b".repeat(64),version:"v22.13.0"},
    dependencyIdentity:"c".repeat(64),environmentIdentity:"d".repeat(64),inputSnapshots:{
      before:{relativePath:`logs/${run}/inputs-before.json`,sha256:"e".repeat(64)},after:{relativePath:`logs/${run}/inputs-after.json`,sha256:"e".repeat(64)}},
    checks:RUNTIME_REPAIR_FIXED_CHECKS.map((argv,index)=>({command:"/fixed-node",argv:[...argv],cwd:"/fixed-checkout",startedAt:"2026-10-12T00:00:00Z",completedAt:"2026-10-12T00:01:00Z",exitCode:0,
      stdout:{relativePath:`logs/${run}/${index}.stdout.log`,sha256:"f".repeat(64)},stderr:{relativePath:`logs/${run}/${index}.stderr.log`,sha256:"f".repeat(64)}}))};
  assert.doesNotThrow(()=>assertRuntimeRepairSourceCheckReceipt(value));
  for (const mutate of [(v:any)=>v.checks.pop(),(v:any)=>v.checks[0].argv.push("--skipLibCheck"),(v:any)=>v.checks[0].cwd="/foreign",
    (v:any)=>delete v.inputSnapshots.after,(v:any)=>v.checks[0].exitCode=1]) {
    const changed=structuredClone(value); mutate(changed); assert.throws(()=>assertRuntimeRepairSourceCheckReceipt(changed),/custody/);
  }
});

import { computeRuntimeFingerprint } from "../src/runtime-fingerprint.js";

test("accepted runtime repair production custody staging retains copied Projects assets without granting changed unmapped output", () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"repair-copied-projects-")));chmodSync(root,0o700);
  const checkout=join(root,"checkout"),managed=join(root,"managed"),old=join(root,"original");mkdirSync(checkout,{mode:0o700});
  let cache:string|undefined;
  const put=(path:string,value:string|Buffer)=>{mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,value,{mode:0o600});};
  const seal=(path:string):void=>{if(lstatSync(path).isDirectory()){for(const name of readdirSync(path))seal(join(path,name));chmodSync(path,0o500);}else chmodSync(path,0o400);};
  const remove=(path:string):void=>{const status=lstatSync(path);if(status.isSymbolicLink()){rmSync(path);return;}if(status.isDirectory()){chmodSync(path,0o700);for(const name of readdirSync(path))remove(join(path,name));}rmSync(path,{recursive:true,force:true});};
  try{
    for(const path of ["packages/installer/src","packages/installer/test","packages/installer/scripts","packages/installer/dist",
      "packages/runtime/src","packages/runtime/test","packages/runtime/scripts","packages/runtime/dist","packages/sdk/src","packages/sdk/test","packages/sdk/dist",
      "scripts","bin","tweaks","store","node_modules/@therealityreport"])
      mkdirSync(join(checkout,path),{recursive:true,mode:0o700});
    for(const path of ["package.json","package-lock.json","tsconfig.base.json","tsconfig.tests.json",...["installer","runtime","sdk"].flatMap(name=>[`packages/${name}/package.json`,`packages/${name}/tsconfig.json`])])put(join(checkout,path),"{}\n");
    put(join(checkout,"packages/sdk/package.json"),JSON.stringify({name:"@therealityreport/tweakers-sdk",main:"dist/index.js",types:"dist/index.d.ts"}));
    symlinkSync("../../packages/sdk",join(checkout,"node_modules/@therealityreport/tweakers-sdk"));
    put(join(checkout,"packages/sdk/dist/index.js"),"module.exports={};\n");put(join(checkout,"packages/sdk/dist/index.d.ts"),"export {};\n");
    put(join(checkout,"packages/runtime/src/main.ts"),"export const repaired = true;\n");
    put(join(checkout,"packages/runtime/dist/main.js"),"exports.repaired = true;\n//# sourceMappingURL=main.js.map\n");
    put(join(checkout,"packages/runtime/dist/main.js.map"),JSON.stringify({version:3,sources:["../src/main.ts"],names:[],mappings:""}));
    mkdirSync(join(managed,"packages/installer/dist"),{recursive:true,mode:0o700});
    cpSync(join(checkout,"packages/sdk/dist"),join(managed,"packages/sdk/dist"),{recursive:true});
    const runtime=join(managed,"packages/installer/assets/runtime");cpSync(join(checkout,"packages/runtime/dist"),runtime,{recursive:true});
    const projectRelative="packages/installer/assets/runtime/tweaks/co.tweakers.projects/index.js",projectPath=join(managed,projectRelative);
    const projects=readFileSync(new URL("../assets/runtime/tweaks/co.tweakers.projects/index.js",import.meta.url));put(projectPath,projects);
    assert.equal(existsSync(join(checkout,"packages/runtime/dist/tweaks/co.tweakers.projects/index.js")),false);
    const publishDocument=(path:string)=>put(join(path,"runtime-fingerprint.json"),JSON.stringify({schemaVersion:1,...computeRuntimeFingerprint(path)})+"\n");
    publishDocument(runtime);
    // Fixture evidence is explicit test data. The real production hook checks
    // the complete inputs, fixed commands, retained logs, snapshots and Node.
    const sourceFiles=collectRuntimeRepairSourceInputs(checkout),node={path:realpathSync(process.execPath),sha256:sha(readFileSync(realpathSync(process.execPath))),version:process.version};
    const inputIdentity=runtimeRepairSourceInputIdentity(sourceFiles),dependencyIdentity=runtimeRepairDependencyIdentity(checkout),environmentIdentity=runtimeRepairSourceEnvironmentIdentity();
    cache=runtimeRepairSourceCheckCache(checkout);const run="11111111-1111-4111-8111-111111111111";
    const snapshot=JSON.stringify({sourceFiles,inputIdentity,dependencyIdentity,environmentIdentity,node})+"\n";
    for(const side of ["before","after"])put(join(cache,`logs/${run}/inputs-${side}.json`),snapshot);
    const checks=RUNTIME_REPAIR_FIXED_CHECKS.map((argv,index)=>{
      const stdout={relativePath:`logs/${run}/${index}.stdout.log`,sha256:sha("fixture pass\n")},stderr={relativePath:`logs/${run}/${index}.stderr.log`,sha256:sha("")};
      put(join(cache!,stdout.relativePath),"fixture pass\n");put(join(cache!,stderr.relativePath),"");
      return{command:node.path,argv:[...argv],cwd:checkout,startedAt:"2026-10-12T00:00:00Z",completedAt:"2026-10-12T00:01:00Z",exitCode:0,stdout,stderr};
    });
    put(join(cache,"checks.json"),JSON.stringify({version:1,kind:"tweakers-runtime-repair-source-checks",checkoutRoot:checkout,sourceFiles,inputIdentity,node,dependencyIdentity,environmentIdentity,
      inputSnapshots:{before:{relativePath:`logs/${run}/inputs-before.json`,sha256:sha(snapshot)},after:{relativePath:`logs/${run}/inputs-after.json`,sha256:sha(snapshot)}},checks})+"\n");
    assert.equal(stageRuntimeRepairSourceCustody(checkout,managed),true,"production staging must accept actual copied Projects JS alongside mapped runtime output");
    const custody=JSON.parse(readFileSync(join(managed,"packages/installer/dist/runtime-repair-source-custody.json"),"utf8"));
    assert.equal(custody.generatedFiles.some((file:any)=>file.relativePath===projectRelative),false,"copied assets gain no compiler grant");
    assert.ok(custody.generatedFiles.some((file:any)=>file.relativePath==="packages/installer/assets/runtime/main.js"));
    assert.deepEqual(readFileSync(projectPath),projects);
    cpSync(managed,old,{recursive:true});put(join(old,"packages/installer/assets/runtime/main.js"),"exports.repaired = false;\n");publishDocument(join(old,"packages/installer/assets/runtime"));
    seal(managed);seal(old);
    assert.deepEqual(readRuntimeRepairSourceCustody(join(managed,"packages/installer/dist")),custody);
    assert.doesNotThrow(()=>reviewRuntimeRepairGeneratedDelta(old,managed,custody));
    const custodyForCurrentRuntime=()=>{
      const document=join(runtime,"runtime-fingerprint.json");chmodSync(runtime,0o700);chmodSync(document,0o600);publishDocument(runtime);chmodSync(document,0o400);chmodSync(runtime,0o500);
      const current=structuredClone(custody);current.packagedRuntime={...computeRuntimeFingerprint(runtime),documentSha256:sha(readFileSync(document))};return current;
    };
    // Even regenerated self-consistent runtime metadata cannot authorize a
    // changed copied asset or a new leaf with no actual compiler mapping.
    chmodSync(projectPath,0o600);writeFileSync(projectPath,Buffer.concat([projects,Buffer.from("\n// unauthorized change\n")]));chmodSync(projectPath,0o400);
    assert.throws(()=>reviewRuntimeRepairGeneratedDelta(old,managed,custodyForCurrentRuntime()),/unreviewed emitted change.*co.tweakers.projects/);
    chmodSync(projectPath,0o600);writeFileSync(projectPath,projects);chmodSync(projectPath,0o400);
    const projectRoot=dirname(projectPath);chmodSync(projectRoot,0o700);put(join(projectRoot,"unmapped.js"),"exports.unauthorized=true;\n");chmodSync(join(projectRoot,"unmapped.js"),0o400);chmodSync(projectRoot,0o500);
    assert.throws(()=>reviewRuntimeRepairGeneratedDelta(old,managed,custodyForCurrentRuntime()),/unreviewed emitted change.*unmapped.js/);
  }finally{
    if(cache)rmSync(dirname(cache),{recursive:true,force:true});remove(root);
  }
});


test("accepted runtime repair production custody retains embedded upstream tar inputs without granting missing vendor sources", () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"repair-embedded-tar-")));chmodSync(root,0o700);
  const checkout=join(root,"checkout"),managed=join(root,"managed"),old=join(root,"original");mkdirSync(checkout,{mode:0o700});
  let cache:string|undefined;
  const put=(path:string,value:string|Buffer)=>{mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,value,{mode:0o600});};
  const source="export const repaired = true;\n", vendor="export class Pack { write () { return true } }\n";
  const sources=["../src/main.ts","../../../node_modules/tar/src/pack.ts","../../../node_modules/tar/node_modules/minipass/src/index.ts"];
  const contents=[source,vendor,"export class Minipass {}\n"];
  const outputRelative="packages/installer/assets/runtime/main.js", output=join(managed,outputRelative);
  try {
    for(const path of ["packages/installer/src","packages/installer/test","packages/installer/scripts","packages/installer/dist",
      "packages/runtime/src","packages/runtime/test","packages/runtime/scripts","packages/runtime/dist","packages/sdk/src","packages/sdk/test","packages/sdk/dist",
      "scripts","bin","tweaks","store","node_modules/@therealityreport"])
      mkdirSync(join(checkout,path),{recursive:true,mode:0o700});
    for(const path of ["package.json","package-lock.json","tsconfig.base.json","tsconfig.tests.json",...["installer","runtime","sdk"].flatMap(name=>[`packages/${name}/package.json`,`packages/${name}/tsconfig.json`])])put(join(checkout,path),"{}\n");
    put(join(checkout,"packages/sdk/package.json"),JSON.stringify({name:"@therealityreport/tweakers-sdk",main:"dist/index.js",types:"dist/index.d.ts"}));
    symlinkSync("../../packages/sdk",join(checkout,"node_modules/@therealityreport/tweakers-sdk"));
    put(join(checkout,"packages/sdk/dist/index.js"),"module.exports={};\n");put(join(checkout,"packages/sdk/dist/index.d.ts"),"export {};\n");
    // npm ships package JavaScript, while esbuild retains upstream TS in its
    // map. No physical tar/minipass TS or synthesized input is installed.
    put(join(checkout,"node_modules/tar/package.json"),JSON.stringify({name:"tar",main:"dist/commonjs/index.js"}));
    put(join(checkout,"node_modules/tar/dist/commonjs/index.js"),"exports.Pack=class Pack {};\n");
    put(join(checkout,"packages/runtime/src/main.ts"),source);
    const compilerOutput=join(checkout,"packages/runtime/dist/main.js");put(compilerOutput,bundle(sources,contents));
    const sourceFiles=collectRuntimeRepairSourceInputs(checkout), mapBytes=Buffer.from(JSON.stringify({version:3,sources,sourcesContent:contents,names:[],mappings:""}));
    assert.deepEqual(runtimeRepairCompilerMapInputs(checkout,compilerOutput,mapBytes,sourceFiles,true),[{relativeSourcePath:"packages/runtime/src/main.ts",sha256:sha(source)}]);
    assert.throws(()=>runtimeRepairCompilerMapInputs(checkout,compilerOutput,mapBytes,sourceFiles),/unresolved or foreign/);
    for(const map of [
      {version:3,sources:["../../../node_modules/tar/src/pack.ts"],names:[],mappings:""},
      {version:3,sources:["../src/missing.ts"],sourcesContent:["missing project"],names:[],mappings:""},
      {version:3,sources:["../../../../node_modules/tar/src/pack.ts"],sourcesContent:[vendor],names:[],mappings:""},
    ])assert.throws(()=>runtimeRepairCompilerMapInputs(checkout,compilerOutput,Buffer.from(JSON.stringify(map)),sourceFiles,true),/unresolved or foreign/);
    mkdirSync(join(managed,"packages/installer/dist"),{recursive:true,mode:0o700});
    cpSync(join(checkout,"packages/sdk/dist"),join(managed,"packages/sdk/dist"),{recursive:true});
    const runtime=join(managed,"packages/installer/assets/runtime");cpSync(join(checkout,"packages/runtime/dist"),runtime,{recursive:true});
    const publishDocument=(path=runtime)=>put(join(path,"runtime-fingerprint.json"),JSON.stringify({schemaVersion:1,...computeRuntimeFingerprint(path)})+"\n");publishDocument();
    const node={path:realpathSync(process.execPath),sha256:sha(readFileSync(realpathSync(process.execPath))),version:process.version};
    const inputIdentity=runtimeRepairSourceInputIdentity(sourceFiles),dependencyIdentity=runtimeRepairDependencyIdentity(checkout),environmentIdentity=runtimeRepairSourceEnvironmentIdentity();
    cache=runtimeRepairSourceCheckCache(checkout);const run="22222222-2222-4222-8222-222222222222";
    const snapshot=JSON.stringify({sourceFiles,inputIdentity,dependencyIdentity,environmentIdentity,node})+"\n";
    for(const side of ["before","after"])put(join(cache,`logs/${run}/inputs-${side}.json`),snapshot);
    const checks=RUNTIME_REPAIR_FIXED_CHECKS.map((argv,index)=>{
      const stdout={relativePath:`logs/${run}/${index}.stdout.log`,sha256:sha("fixture pass\n")},stderr={relativePath:`logs/${run}/${index}.stderr.log`,sha256:sha("")};
      put(join(cache!,stdout.relativePath),"fixture pass\n");put(join(cache!,stderr.relativePath),"");
      return{command:node.path,argv:[...argv],cwd:checkout,startedAt:"2026-10-12T00:00:00Z",completedAt:"2026-10-12T00:01:00Z",exitCode:0,stdout,stderr};
    });
    put(join(cache,"checks.json"),JSON.stringify({version:1,kind:"tweakers-runtime-repair-source-checks",checkoutRoot:checkout,sourceFiles,inputIdentity,node,dependencyIdentity,environmentIdentity,
      inputSnapshots:{before:{relativePath:`logs/${run}/inputs-before.json`,sha256:sha(snapshot)},after:{relativePath:`logs/${run}/inputs-after.json`,sha256:sha(snapshot)}},checks})+"\n");
    assert.equal(stageRuntimeRepairSourceCustody(checkout,managed),true,"real build hook accepts retained embedded upstream sources, with no source grant");
    const custody=JSON.parse(readFileSync(join(managed,"packages/installer/dist/runtime-repair-source-custody.json"),"utf8"));
    const mapped=custody.generatedFiles.find((file:any)=>file.relativePath===outputRelative);
    assert.equal(mapped.mappingKind,"esbuild-source-map");assert.deepEqual(mapped.sourceInputs,[{relativeSourcePath:"packages/runtime/src/main.ts",sha256:sha(source)}]);
    cpSync(managed,old,{recursive:true});put(join(old,outputRelative),bundle(sources,["old main",...contents.slice(1)]));publishDocument(join(old,"packages/installer/assets/runtime"));
    const sealLeaves=(path:string):void=>{if(lstatSync(path).isDirectory()){for(const name of readdirSync(path))sealLeaves(join(path,name));}else chmodSync(path,0o400);};
    sealLeaves(managed);sealLeaves(old);
    // The retained upstream embedded bytes are unchanged; only reviewed main
    // differs. Complete old/new inventory and embedded comparison both run.
    assert.doesNotThrow(()=>reviewRuntimeRepairGeneratedDelta(old,managed,custody));
    const custodyFor=(bytes:Buffer)=>{
      chmodSync(output,0o600);writeFileSync(output,bytes);chmodSync(output,0o400);
      chmodSync(join(runtime,"runtime-fingerprint.json"),0o600);publishDocument();chmodSync(join(runtime,"runtime-fingerprint.json"),0o400);
      const current=structuredClone(custody);current.generatedFiles.find((file:any)=>file.relativePath===outputRelative).sha256=sha(bytes);
      current.packagedRuntime={...computeRuntimeFingerprint(runtime),documentSha256:sha(readFileSync(join(runtime,"runtime-fingerprint.json")))};return current;
    };
    assert.throws(()=>reviewRuntimeRepairGeneratedDelta(old,managed,custodyFor(bundle(sources,[source,"changed upstream tar",contents[2]!]))),/unreviewed bundled source change.*node_modules\/tar/);
    assert.throws(()=>reviewRuntimeRepairGeneratedDelta(old,managed,custodyFor(bundle([...sources,"../../../node_modules/new-vendor/src/index.ts"],[...contents,"new vendor"]))),/unreviewed bundled source change.*new-vendor/);
    const restored=custodyFor(bundle(sources,contents)), newRelative="packages/sdk/dist/new-bundle.js", newBytes=bundle(sources,contents);
    put(join(managed,newRelative),newBytes);chmodSync(join(managed,newRelative),0o400);
    restored.generatedFiles.push({...mapped,relativePath:newRelative,sha256:sha(newBytes)});
    assert.throws(()=>reviewRuntimeRepairGeneratedDelta(old,managed,restored),/new bundle lacks retained original source inputs/);
  } finally { if(cache)rmSync(dirname(cache),{recursive:true,force:true});rmSync(root,{recursive:true,force:true}); }
});

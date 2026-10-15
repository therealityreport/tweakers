import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installedMetadataRepairPath, recordInstalledMetadataRepair, verifyInstalledMetadataRepair } from "../src/installed-metadata-repair.js";
import { fingerprintVariantGeneration } from "../src/variant-generation.js";
import { inspectLocalArtifactCapacity, reconcileArtifactDeviceIdentities } from "../src/local-artifacts.js";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-metadata-repair-"))), target = join(root, "Tweakers.app"), variantRoot = join(root, "variants/tweakers");
  const names = ["Contents/Info.plist", "Contents/MacOS/ChatGPT", "Contents/_CodeSignature/CodeResources"];
  const repairRoot = join(root, "repairs/20261010T164301Z-codex-alias"), files: Record<string,string> = {};
  for(const name of [...names,"Contents/Resources/unchanged"]) {
    mkdirSync(dirname(join(target,name)),{recursive:true});writeFileSync(join(target,name),`original ${name}`);
  }
  const original = fingerprintVariantGeneration(target), promotionId = randomUUID();
  for(const name of names) {
    mkdirSync(dirname(join(repairRoot,"before",name)),{recursive:true});cpSync(join(target,name),join(repairRoot,"before",name));
    files[name]=createHash("sha256").update(readFileSync(join(target,name))).digest("hex");
    writeFileSync(join(target,name),`repaired ${name}`);
  }
  writeFileSync(join(repairRoot,"manifest-before.json"),JSON.stringify({files}));
  writeFileSync(join(repairRoot,"receipt.json"),JSON.stringify({app:target,backup:join(repairRoot,"before"),removedAlternateNames:["Codex"],completedAt:new Date().toISOString(),signatureVerified:true,sameCertificate:true,sameSigningRequirementsAndEntitlements:true,officialAppUnchanged:true}));
  const active={version:3,id:promotionId,userRoot:variantRoot,target,entries:[{name:"app",path:target,fingerprint:original}]};
  const journals=join(variantRoot,"transactions/variant-promotion");mkdirSync(journals,{recursive:true});
  writeFileSync(join(journals,"active.json"),JSON.stringify(active));
  writeFileSync(join(journals,`${promotionId}.json`),JSON.stringify({version:3,id:promotionId,userRoot:variantRoot,target,phase:"committed",entries:[{name:"app",destination:target,desired:original}],activeReceipt:{expected:active}}));
  return {root,target,variantRoot,promotionId,original,repairRoot,names,inode:lstatSync(target).ino};
}

test("completed repair recovers repeatably without rewriting the original receipts",()=>{
  const f=fixture();try {
    const active=readFileSync(join(f.variantRoot,"transactions/variant-promotion/active.json"));
    const current=fingerprintVariantGeneration(f.target);
    assert.deepEqual(recordInstalledMetadataRepair(f,f.repairRoot,()=>{}),current);
    assert.deepEqual(verifyInstalledMetadataRepair(f),current);
    assert.deepEqual(recordInstalledMetadataRepair(f,f.repairRoot,()=>{}),current);
    assert.deepEqual(readFileSync(join(f.variantRoot,"transactions/variant-promotion/active.json")),active);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

for(const alteration of ["backup","unrelated","inode","parent","after"] as const) test(`repair recovery blocks ${alteration} changes`,()=>{
  const f=fixture();try {
    recordInstalledMetadataRepair(f,f.repairRoot,()=>{});
    if(alteration==="backup")writeFileSync(join(f.repairRoot,"before",f.names[0]!),"altered backup");
    if(alteration==="unrelated")writeFileSync(join(f.target,"Contents/Resources/unchanged"),"unrelated edit");
    if(alteration==="inode") {renameSync(f.target,`${f.target}.old`);cpSync(`${f.target}.old`,f.target,{recursive:true});}
    if(alteration==="parent")writeFileSync(join(f.variantRoot,"transactions/variant-promotion",`${f.promotionId}.json`),"{}");
    if(alteration==="after")writeFileSync(join(f.target,f.names[0]!),"changed repaired file");
    assert.throws(()=>verifyInstalledMetadataRepair(f),/repair|promotion/);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("failed signature or recovery verification never publishes the repair receipt",()=>{
  for(const failure of ["invalid signature","recovery unavailable"]) {
    const f=fixture();try {
      assert.throws(()=>recordInstalledMetadataRepair(f,f.repairRoot,()=>{throw new Error(failure);}),new RegExp(failure));
      assert.equal(existsSync(installedMetadataRepairPath(f)),false);
    } finally {rmSync(f.root,{recursive:true,force:true});}
  }
});

test("a replacement inode cannot acquire the initial repair receipt",()=>{
  const f=fixture();try {
    renameSync(f.target,`${f.target}.old`);cpSync(`${f.target}.old`,f.target,{recursive:true});
    assert.throws(()=>recordInstalledMetadataRepair(f,f.repairRoot,()=>{}),/inode changed/);
    assert.equal(existsSync(installedMetadataRepairPath(f)),false);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("a verified repair reconciles the remount while preserving a real download slot",()=>{
  const f=fixture();try {
    const raw=join(f.root,"download.app");mkdirSync(raw);
    const identity=lstatSync(f.target),registry=join(f.root,"local-artifact-reservations.json");
    const downloaded={id:"download",state:"reserved",paths:[raw],operationId:"source-download"};
    const installed={id:"installed",state:"installed",paths:[f.target],generationFingerprint:f.original,
      generationIdentity:{dev:identity.dev+1,ino:identity.ino},transactionRef:join(f.variantRoot,"transactions/variant-promotion",`${f.promotionId}.json`)};
    writeFileSync(registry,JSON.stringify({version:1,reservations:[installed,downloaded]}));
    assert.equal(inspectLocalArtifactCapacity(f.root,f.target).occupied,3);
    recordInstalledMetadataRepair(f,f.repairRoot,()=>{});
    const reconcile=()=>reconcileArtifactDeviceIdentities(f.root,fingerprintVariantGeneration,()=>verifyInstalledMetadataRepair(f));
    assert.deepEqual(reconcile(),["installed"]);
    assert.equal(inspectLocalArtifactCapacity(f.root,f.target).occupied,2);
    assert.deepEqual(reconcile(),[]);
    assert.deepEqual(JSON.parse(readFileSync(registry,"utf8")).reservations[1],downloaded);
    const altered=JSON.parse(readFileSync(registry,"utf8"));altered.reservations[0].generationIdentity.dev+=1;
    writeFileSync(registry,JSON.stringify(altered));writeFileSync(join(f.repairRoot,"before",f.names[0]!),"altered backup");
    assert.throws(reconcile,/backup changed/);
    assert.equal(inspectLocalArtifactCapacity(f.root,f.target).occupied,3);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

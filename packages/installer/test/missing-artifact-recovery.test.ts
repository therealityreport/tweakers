import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { create as createTar } from "tar";
import { recoverMissingArtifact, recoveryCanonical, reserveCurrentSealedManagerRecoveryAdmission, validateMissingArtifactSuccessor, type RecoveryHost, type RecoveryManifest, type RecoveryManagerAdmissionDependencies, type RestoredProof } from "../src/missing-artifact-recovery";
import { inspectLocalArtifactCapacity, readReservations, releaseEmptyLocalArtifactReservation, retireLocalArtifactAt } from "../src/local-artifacts";
import { maintainTerminalOperationResults } from "../src/artifact-maintenance";
import { resolveSealedManagerManagedRuntimeAssets } from "../src/manager-runtime-assets";
import { tweakersManagerDescriptorPaths } from "../src/manager-descriptor";
import { restoreSealedArchiveFileContents, sealArchiveTree } from "../src/doctor-baseline";
import { sealOfficialSourceTree } from "../src/official-source-registration";
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const write=(path:string,value:unknown)=>{mkdirSync(join(path,".."),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(value),{mode:0o600});};
const envelope=(body:unknown)=>({version:1,body,sha256:digest(recoveryCanonical(body))});
test("archive restoration accepts canonical seal field order and rejects each changed field before writes",()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tweakers-restoration-seal-order-")));
  try {
    const appName="Tweakers.app",source=join(root,"source",appName),restored=join(root,"restored",appName),archive=join(root,"fixture.tar");
    mkdirSync(source,{recursive:true,mode:0o700});mkdirSync(restored,{recursive:true,mode:0o700});
    writeFileSync(join(source,"payload"),"independently archived bytes\n",{mode:0o400});
    writeFileSync(join(restored,"payload"),"wrong restored bytes\n",{mode:0o400});
    createTar({sync:true,file:archive,cwd:join(root,"source")},[appName]);
    const seal=sealArchiveTree(archive,appName),expected=JSON.parse(recoveryCanonical(seal)) as typeof seal;
    assert.deepEqual(seal,sealOfficialSourceTree(source));
    assert.notDeepEqual(Object.keys(seal),Object.keys(expected),"canonical immutable manifest orders seal keys differently");
    const archiveBefore=readFileSync(archive);
    const restoredSnapshot=()=>[restored,join(restored,"payload")].map(path=>{
      const stat=lstatSync(path);
      return {path,dev:stat.dev,ino:stat.ino,mode:stat.mode,uid:stat.uid,gid:stat.gid,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,
        bytes:stat.isFile()?readFileSync(path).toString("base64"):null};
    });
    for(const changed of [{...expected,sha256:digest("wrong seal")},{...expected,entries:expected.entries+1},
      {...expected,bytes:(BigInt(expected.bytes)+1n).toString()}]) {
      const before=restoredSnapshot();
      assert.throws(()=>restoreSealedArchiveFileContents(archive,appName,restored,changed),/Restoration archive identity changed/);
      assert.deepEqual(restoredSnapshot(),before,"every changed seal field must refuse before restored writes");
    }
    restoreSealedArchiveFileContents(archive,appName,restored,expected);
    assert.deepEqual(readFileSync(join(restored,"payload")),readFileSync(join(source,"payload")));
    assert.deepEqual(sealOfficialSourceTree(restored),seal);
    assert.deepEqual(readFileSync(archive),archiveBefore);
  } finally {rmSync(root,{recursive:true,force:true});}
});
function managerAdmissionFixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tweakers-recovery-admission-"))),paths=tweakersManagerDescriptorPaths(root,join(root,"descriptors")),managerRoot=paths.managerRoot;
  const current={generationId:digest("current"),sealSha256:digest("seal"),runtimeFingerprint:digest("runtime"),managedRuntimeFingerprint:digest("managed")};
  const previous=digest("previous"),bundle=join(paths.generationsRoot,current.generationId,"manager.mjs");
  mkdirSync(join(bundle,".."),{recursive:true,mode:0o700});
  writeFileSync(bundle,`
export const observations={reserved:0,released:0,releaseError:false};
let reserveHook=()=>{};
export function setReserveHook(hook){reserveHook=hook;}
export async function reserveClosedIndependentTweakersCutover(){
  const compiledManagedFingerprint=${JSON.stringify(current.managedRuntimeFingerprint)};
  if(!/^[a-f0-9]{64}$/.test(compiledManagedFingerprint))throw new Error('Cutover requires the sealed Manager runtime');
  observations.reserved++;reserveHook();
  return {async release(){observations.released++;if(observations.releaseError)throw new Error('fixture release failure');}};
}
`,{mode:0o400});
  type FixtureModule={observations:{reserved:number;released:number;releaseError:boolean};setReserveHook(hook:()=>void):void};
  const state:{imports:string[];verified:string[];module?:FixtureModule;importHook?:()=>void;reserveHook?:()=>void}={imports:[],verified:[]};
  const verified={generationId:current.generationId,sealSha256:current.sealSha256,
    moduleRoot:join(managerRoot,"managed-runtime-generations",current.managedRuntimeFingerprint,"packages/installer/dist"),
    runtimeRoot:join(managerRoot,"runtime-generations",current.runtimeFingerprint)};
  const dependencies:RecoveryManagerAdmissionDependencies={
    canonicalRoot:()=>root,descriptorPaths:()=>paths,readCurrent:()=>({...current}),
    verifyRetained(id){state.verified.push(id);return {...verified};},
    async importBundle(url){state.imports.push(url);state.module=await import(url) as FixtureModule;
      state.module.setReserveHook(()=>state.reserveHook?.());state.importHook?.();return state.module;}
  };
  return {root,current,previous,bundle,verified,state,dependencies,dispose:()=>rmSync(root,{recursive:true,force:true})};
}
test("ordinary source reserves the fixed current sealed Manager export and releases once",async()=>{
  const f=managerAdmissionFixture();try {
    assert.equal(resolveSealedManagerManagedRuntimeAssets(),null,"ordinary source cannot supply the sealed guard itself");
    const admission=await reserveCurrentSealedManagerRecoveryAdmission(f.root,f.dependencies);
    assert.deepEqual(f.state.imports,[pathToFileURL(f.bundle).href]);assert.equal(f.state.module!.observations.reserved,1);
    assert.ok(f.state.verified.length>=3);assert.ok(f.state.verified.every(id=>id===f.current.generationId&&id!==f.previous));
    await admission.release();await admission.release();assert.equal(f.state.module!.observations.released,1);
  }finally{f.dispose();}
});
for(const failure of ["root","generation","seal","runtime","module"])test(`sealed recovery admission rejects invalid ${failure} before import`,async()=>{
  const f=managerAdmissionFixture();try {
    if(failure==="root")f.dependencies.canonicalRoot=()=>join(f.root,"other");
    else if(failure==="generation")f.current.generationId="invalid";
    else if(failure==="seal")f.verified.sealSha256=digest("wrong seal");
    else if(failure==="runtime")f.verified.runtimeRoot=join(f.root,"caller-selected-runtime");
    else f.verified.moduleRoot=join(f.root,"caller-selected-module");
    await assert.rejects(reserveCurrentSealedManagerRecoveryAdmission(f.root,f.dependencies),/canonical|Invalid|binding changed/);
    assert.equal(f.state.imports.length,0);
  }finally{f.dispose();}
});
test("missing current sealed guard or import failure cannot reserve admission",async()=>{
  for(const failure of ["export","import"]) {const f=managerAdmissionFixture();try {
    f.dependencies.importBundle=async url=>{assert.equal(url,pathToFileURL(f.bundle).href);if(failure==="import")throw new Error("fixture import failure");return {};};
    await assert.rejects(reserveCurrentSealedManagerRecoveryAdmission(f.root,f.dependencies),failure==="import"?/fixture import failure/:/lacks the recovery admission guard/);
    assert.equal(f.state.module,undefined);
  }finally{f.dispose();}}
});
test("current generation drift during import blocks admission without importing a successor",async()=>{
  const f=managerAdmissionFixture();try {
    f.state.importHook=()=>{f.current.generationId=f.previous;};
    await assert.rejects(reserveCurrentSealedManagerRecoveryAdmission(f.root,f.dependencies),/Current Manager generation changed/);
    assert.deepEqual(f.state.imports,[pathToFileURL(f.bundle).href]);assert.equal(f.state.module!.observations.reserved,0);
    assert.equal(f.state.module!.observations.released,0);
  }finally{f.dispose();}
});
test("sealed runtime drift during import blocks before admission",async()=>{
  const f=managerAdmissionFixture();try {
    f.state.importHook=()=>{f.verified.sealSha256=digest("changed seal");};
    await assert.rejects(reserveCurrentSealedManagerRecoveryAdmission(f.root,f.dependencies),/sealed runtime binding changed/);
    assert.equal(f.state.module!.observations.reserved,0);assert.equal(f.state.module!.observations.released,0);
  }finally{f.dispose();}
});
test("post-admission current drift releases exactly once and preserves a release failure",async()=>{
  for(const releaseFails of [false,true]) {const f=managerAdmissionFixture();try {
    f.state.reserveHook=()=>{f.current.generationId=f.previous;f.state.module!.observations.releaseError=releaseFails;};
    await assert.rejects(reserveCurrentSealedManagerRecoveryAdmission(f.root,f.dependencies),error=>{
      if(releaseFails) {assert.ok(error instanceof AggregateError);assert.match(error.errors[0].message,/Current Manager generation changed/);assert.match(error.errors[1].message,/fixture release failure/);}
      else assert.match((error as Error).message,/Current Manager generation changed/);
      return true;
    });
    assert.equal(f.state.module!.observations.reserved,1);assert.equal(f.state.module!.observations.released,1);
    assert.deepEqual(f.state.imports,[pathToFileURL(f.bundle).href]);
  }finally{f.dispose();}}
});
test("post-admission sealed verification errors release before rejection",async()=>{
  const f=managerAdmissionFixture();try {
    f.state.reserveHook=()=>{f.dependencies.verifyRetained=()=>{throw new Error("fixture sealed verification failed");};};
    await assert.rejects(reserveCurrentSealedManagerRecoveryAdmission(f.root,f.dependencies),/fixture sealed verification failed/);
    assert.equal(f.state.module!.observations.released,1);
  }finally{f.dispose();}
});
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tweakers-missing-recovery-"))),id=randomUUID(),journalId=randomUUID(),receiptId=randomUUID(),operationId=randomUUID();
  const original=join(root,"variants/tweakers/builds",journalId,"failed-promotion/app/Tweakers.app"),receipt=join(root,"artifact-archives/failed-promotion-retirement",`${receiptId}.json`),journal=join(root,"variants/tweakers/transactions/variant-promotion",`${journalId}.json`);
  const archive=`/Volumes/SHOWS DB/_Mac-Archive/Tweakers/failed-promotions/${journalId}-${receiptId}.tar`,seal={sha256:digest("seal"),entries:2,bytes:"16"},metadata={".":{acl:null,flags:0,xattrs:{}}};
  const fingerprint={kind:"directory" as const,mode:493,sha256:digest("fingerprint")},fallback={id:randomUUID(),fingerprints:[],recoveryVerified:true};
  write(journal,{version:3,id:journalId,phase:"recovered",entries:[{name:"app",failed:original,desired:fingerprint}]});
  write(join(root,"local-operation",`result-${operationId}.json`),{version:1,id:operationId,state:"completed",pid:999999,processStartedAt:"dead owner",children:[],startedAt:"2020-01-01T00:00:00Z",kind:"fixture owner"});
  const prior={version:1,metadataVersion:1,phase:"verified",reservationId:id,journalId,journalSha256:digest(readFileSync(journal,"utf8")),original,
    trash:join(homedir(),".Trash",`Tweakers-failed-promotion-${receiptId}`),archive,archiveSHA256:digest("archive"),archiveVolume:"/Volumes/SHOWS DB",volumeUUID:randomUUID(),
    originalIdentity:{dev:1,ino:2},originalSeal:seal,originalMetadata:metadata,fallback,restorationVerified:true,retired:false,reservationReconciled:false,
    proofImage:`/Volumes/SHOWS DB/_Mac-Archive/Tweakers/failed-promotions/${receiptId}.restore.sparseimage`,proofImageIdentity:{dev:3,ino:4},proofImageDetached:true,
    moveState:{phase:"prepared",entries:[{original,trash:join(homedir(),".Trash",`Tweakers-failed-promotion-${receiptId}`),phase:"prepared"}]}};
  const archiveSnapshot={dev:"3",ino:"5",size:"10",mtimeNs:"11",ctimeNs:"12",mode:"33152",uid:String(process.getuid?.()),nlink:"1"},archiveParent={dev:"3",ino:"6"};
  const correctionBody={archive,archiveSHA256:prior.archiveSHA256,volumeUUID:prior.volumeUUID,restorationVerified:true,proofImageIdentity:prior.proofImageIdentity,
    priorReceiptText:JSON.stringify(prior),priorReceiptSHA256:digest(JSON.stringify(prior)),finalSnapshot:archiveSnapshot,finalIdentity:{dev:"3",ino:"5"},parentIdentity:archiveParent};
  const correction=envelope(correctionBody);write(`${receipt}.archive-identity.json`,correction);
  write(receipt,{...prior,archiveIdentityCorrection:{path:`${receipt}.archive-identity.json`,sha256:correction.sha256},
    moveState:{...prior.moveState,entries:[{...prior.moveState.entries[0],phase:"moved"}]},consumerCensus:{at:"historical",loaded:[],persisted:[],excluded:[]}});
  write(join(root,"local-artifact-reservations.json"),{version:1,reservations:[{id,paths:[original],state:"partial",operationId,ownerPid:999999,ownerStartedAt:"dead owner",transactionRef:journal,generationIdentity:prior.originalIdentity,generationFingerprint:fingerprint}]});
  const state={create:0,extract:0,detach:0,locks:0,admission:0,mounted:false,image:false,fail:"",archiveDrift:false,mountDrift:false};
  const proof:RestoredProof={identity:{dev:"10",ino:"20"},seal,metadata,fingerprint};
  const host:RecoveryHost={
    async archive() {if(state.archiveDrift)throw new Error("Archive checksum drift");},
    fileSnapshot:()=>archiveSnapshot,fileIdentity:path=>path.endsWith(".restore.sparseimage")?{dev:"3",ino:"4"}:path.endsWith(".sparseimage")?{dev:"3",ino:"50"}:archiveParent,
    allocationAbsent:path=>path.endsWith(".sparseimage")?!state.image:true,
    space() {if(state.fail==="space")throw new Error("Archive lacks restoration capacity");},
    capacity:()=>({occupied:2,blockers:state.fail==="capacity"?["duplicate"]:[]}),
    volume() {if(state.fail==="volume")throw new Error("Archive volume changed");},
    async fallback(){return state.fail==="fallback"?{}:fallback;},
    consumers(){if(state.fail==="owner")throw new Error("Terminal owner descendants are still alive");if(state.fail==="consumers")throw new Error("Recovery payload has launch consumers");},
    imageMappings:()=>state.mounted?[{image:readReservations(root)[0]!.missingRecovery!.proof.image,mounts:[state.mountDrift?"/Volumes/Other":readReservations(root)[0]!.missingRecovery!.proof.mount]}]:[],
    mountBoundary(){if(state.fail==="boundary")throw new Error("Recovery mount lacks noexec/nosuid/owners");},
    createImage(){state.create++;state.image=true;if(state.fail==="create")throw new Error("Interrupted after unbound image creation");},
    attach(){state.mounted=true;if(state.fail==="attach")throw new Error("Interrupted after attach");},
    extract(){state.extract++;if(state.fail==="extract")throw new Error("Interrupted while restoring");},
    restored:()=>state.fail==="metadata"?{...proof,metadata:{}}:state.fail==="fingerprint"?{...proof,fingerprint:{...fingerprint,sha256:digest("wrong")}}:state.fail==="lineage"?{...proof,identity:{dev:"1",ino:"2"}}:proof,
    detach(){state.detach++;state.mounted=false;if(state.fail==="detach")throw new Error("Interrupted after detach");},
    async reserveAdmission(admissionRoot){assert.equal(admissionRoot,root);state.admission++;if(state.fail==="admission")throw new Error("Broker not closed");return {async release(){state.admission--;}};},
    async withLocks(_root,run){state.locks++;try{return await run();}finally{state.locks--;}}
  };
  const dispose=()=>rmSync(root,{recursive:true,force:true});
  return {root,id,journal,receipt,original,host,state,proof,dispose};
}
function snapshotTree(root:string):string {
  const walk=(path:string):unknown=>readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).map(row=>[row.name,row.isDirectory()?walk(join(path,row.name)):readFileSync(join(path,row.name),"utf8")]);
  return JSON.stringify(walk(root));
}
test("preview preserves all bytes and does not reserve admission, locks, images, or bootstrap",async()=>{
  const f=fixture();try{const before=snapshotTree(f.root),old=readFileSync(f.receipt);
    f.host.reserveAdmission=async()=>{assert.fail("preview must not load or import the current Manager");};
    const result=await recoverMissingArtifact(f.root,f.id,{},f.host);
    assert.equal(result.applied,false);assert.equal(result.transactionId,null);assert.equal(snapshotTree(f.root),before);assert.deepEqual(readFileSync(f.receipt),old);
    assert.equal(f.state.admission,0);assert.equal(f.state.locks,0);assert.equal(f.state.create,0);
  }finally{f.dispose();}
});
test("success retires the same reservation with new lineage and explicitly unknown historical Trash disposition",async()=>{
  const f=fixture();try{const old=readFileSync(f.receipt),result=await recoverMissingArtifact(f.root,f.id,{apply:true},f.host);
    const reservation=readReservations(f.root)[0]!;assert.equal(reservation.id,f.id);assert.equal(reservation.state,"retired");assert.equal(reservation.paths[0],f.original);
    assert.equal(f.state.create,1);assert.equal(f.state.mounted,false);assert.equal(f.state.admission,0);assert.deepEqual(readFileSync(f.receipt),old);
    const successor=JSON.parse(readFileSync(result.receipt!,"utf8")).body;assert.equal(successor.historicalTrashMove,"unknown");assert.deepEqual(successor.lineage.restored,f.proof.identity);
    assert.notDeepEqual(successor.lineage.historical,successor.lineage.restored);
    const again=await recoverMissingArtifact(f.root,f.id,{apply:true,transactionId:result.transactionId!},f.host);assert.equal(again.phase,"reconciled");assert.equal(f.state.create,1);
  }finally{f.dispose();}
});
for(const failure of ["volume","fallback","owner","consumers","capacity","space","admission","boundary","metadata","fingerprint","lineage"])test(`fails closed for ${failure}`,async()=>{
  const f=fixture();try{f.state.fail=failure;const old=readFileSync(f.receipt);
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host));assert.notEqual(readReservations(f.root)[0]!.state,"retired");assert.deepEqual(readFileSync(f.receipt),old);
  }finally{f.dispose();}
});
for(const failure of ["attach","extract","detach"])test(`resume after ${failure} reuses one allocation and one proof image`,async()=>{
  const f=fixture();try{f.state.fail=failure;await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host));
    const before=readReservations(f.root)[0]!,transactionId=before.missingRecovery!.transactionId;assert.equal(before.state,"partial");assert.equal(f.state.create,1);
    assert.throws(()=>releaseEmptyLocalArtifactReservation(f.root,f.id),/successor receipt/);
    assert.throws(()=>retireLocalArtifactAt(f.root,f.original,f.receipt),/successor receipt/);
    f.state.fail="";const result=await recoverMissingArtifact(f.root,f.id,{apply:true,transactionId},f.host);assert.equal(result.phase,"reconciled");assert.equal(f.state.create,1);
  }finally{f.dispose();}
});
test("unbound creation interruption preserves occupied allocation and blocks adoption or another image",async()=>{
  const f=fixture();try{f.state.fail="create";await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host));const row=readReservations(f.root)[0]!;
    assert.equal(row.state,"partial");assert.equal(inspectLocalArtifactCapacity(f.root,join(f.root,"installed.app")).occupied,1);
    f.state.fail="";await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true,transactionId:row.missingRecovery!.transactionId},f.host),/Unbound/);assert.equal(f.state.create,1);
  }finally{f.dispose();}
});
test("changed pinned journal, archive checksum, or image mount blocks resume",async()=>{
  for(const drift of ["journal","archive","mount"]) {const f=fixture();try{f.state.fail="extract";await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host));
    const row=readReservations(f.root)[0]!;f.state.fail="";
    if(drift==="journal")write(f.journal,{phase:"committed"});else if(drift==="archive")f.state.archiveDrift=true;else f.state.mountDrift=true;
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true,transactionId:row.missingRecovery!.transactionId},f.host));assert.equal(readReservations(f.root)[0]!.state,"partial");assert.equal(f.state.create,1);
  }finally{f.dispose();}}
});
test("returning original blocks recovery and is accounted as another copy",async()=>{
  const f=fixture();try{f.state.fail="extract";await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host));const row=readReservations(f.root)[0]!;
    mkdirSync(f.original,{recursive:true});writeFileSync(join(f.original,"payload"),"returned");
    const count=inspectLocalArtifactCapacity(f.root,join(f.root,"installed.app"));assert.ok(count.blockers.some(message=>message.includes("reappeared")));assert.equal(count.occupied,2);
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true,transactionId:row.missingRecovery!.transactionId},f.host),/reappeared/);
  }finally{f.dispose();}
});
test("a rewritten successor cannot assert the historical Trash move or historical inode",async()=>{
  const f=fixture();try{const result=await recoverMissingArtifact(f.root,f.id,{apply:true},f.host),directory=join(result.receipt!,".."),manifest=JSON.parse(readFileSync(join(directory,"input.json"),"utf8")).body as RecoveryManifest;
    const successor=JSON.parse(readFileSync(result.receipt!,"utf8")).body;write(result.receipt!,envelope({...successor,historicalTrashMove:"verified"}));
    assert.throws(()=>validateMissingArtifactSuccessor(f.root,manifest,result.receipt!),/Invalid/);
  }finally{f.dispose();}
});
test("source operator dispatch precedes build/dependency work and uses the shared implementation",()=>{
  const source=readFileSync(new URL("../../../scripts/local-work.mjs",import.meta.url),"utf8"),branch=source.indexOf("if (mode === 'recover-missing-artifact')");
  assert.ok(branch>=0&&branch<source.indexOf("const requestKey="));assert.match(source.slice(branch,source.indexOf("const fileDigests")),/missing-artifact-recovery\.ts/);
  assert.doesNotMatch(source.slice(branch,source.indexOf("const fileDigests")),/build\(|bootstrap|ensureUserPaths|withLocalOperation\(/);
});
test("dead creator PID never retires an installed generation",async()=>{
  const f=fixture();try{const rows=readReservations(f.root);rows[0]!.state="installed";write(join(f.root,"local-artifact-reservations.json"),{version:1,reservations:rows});
    const before=snapshotTree(f.root);await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host),/explicit recovery/);
    assert.equal(readReservations(f.root)[0]!.state,"installed");assert.equal(snapshotTree(f.root),before);
  }finally{f.dispose();}
});
test("wrong terminal owner or correction lineage blocks before any proof allocation",async()=>{
  for(const target of ["owner","correction"]) {const f=fixture();try{
    if(target==="owner") {const row=readReservations(f.root)[0]!,path=join(f.root,"local-operation",`result-${row.operationId}.json`),owner=JSON.parse(readFileSync(path,"utf8"));write(path,{...owner,state:"running"});}
    else {const path=`${f.receipt}.archive-identity.json`,value=JSON.parse(readFileSync(path,"utf8")).body;write(path,envelope({...value,finalIdentity:{dev:"0",ino:"0"}}));}
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host));assert.equal(f.state.create,0);assert.equal(readReservations(f.root)[0]!.state,"partial");
  }finally{f.dispose();}}
});
test("full prior reservation drift at locked admission blocks allocation",async()=>{
  const f=fixture();try{const original=f.host.withLocks;f.host.withLocks=async(root,work)=>{
    const rows=readReservations(root);rows[0]!.ownerStartedAt="changed";write(join(root,"local-artifact-reservations.json"),{version:1,reservations:rows});return original(root,work);
  };
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host),/allocation conflicts/);assert.equal(f.state.create,0);
  }finally{f.dispose();}
});
test("a modified append-only transition cannot be resumed",async()=>{
  const f=fixture();try{f.state.fail="extract";await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host));const row=readReservations(f.root)[0]!,transactionId=row.missingRecovery!.transactionId;
    const path=join(row.missingRecovery!.manifest,"..","000001.json"),transition=JSON.parse(readFileSync(path,"utf8"));
    write(path,envelope({...transition.body,previousSHA256:"0".repeat(64)}));f.state.fail="";
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true,transactionId},f.host),/transition chain changed/);assert.equal(f.state.create,1);assert.equal(readReservations(f.root)[0]!.state,"partial");
  }finally{f.dispose();}
});
for(const phase of ["restoration-verified","detaching"])test(`resume rejects same-content restored inode substitution in ${phase}`,async()=>{
  const f=fixture();try{
    const old=readFileSync(f.receipt);
    if(phase==="restoration-verified") {
      const restored=f.host.restored;
      f.host.restored=manifest=>{
        const directory=join(readReservations(f.root)[0]!.missingRecovery!.manifest,".."),names=readdirSync(directory).filter(name=>/^\d{6}\.json$/.test(name)).sort();
        const last=JSON.parse(readFileSync(join(directory,names.at(-1)!),"utf8")).body;
        if(last.phase==="restoration-verified")throw new Error("Interrupted after restoration proof publication");
        return restored(manifest);
      };
    }else f.host.detach=()=>{throw new Error("Interrupted before detach");};
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host),/Interrupted/);
    const reservation=readReservations(f.root)[0]!,transactionId=reservation.missingRecovery!.transactionId;
    assert.equal(reservation.state,"partial");assert.equal(f.state.mounted,true);assert.equal(f.state.create,1);
    const manifestDirectory=join(reservation.missingRecovery!.manifest,".."),transitions=readdirSync(manifestDirectory).filter(name=>/^\d{6}\.json$/.test(name)).sort();
    const pinned=JSON.parse(readFileSync(join(manifestDirectory,transitions.at(-1)!),"utf8")).body;
    assert.equal(pinned.phase,phase);assert.deepEqual(pinned.restored,f.proof);
    // Bytes, seal, metadata, and generation fingerprint remain unchanged. Only
    // the restored directory's identity changes, which must block retirement.
    f.host.restored=()=>({...f.proof,identity:{...f.proof.identity,ino:"21"}});
    f.host.detach=()=>{f.state.detach++;f.state.mounted=false;};
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true,transactionId},f.host),/pinned lineage must remain exact/);
    assert.equal(f.state.detach,0);assert.equal(f.state.mounted,true);assert.equal(f.state.create,1);
    assert.equal(readReservations(f.root)[0]!.state,"partial");assert.deepEqual(readFileSync(f.receipt),old);
    assert.ok(!readdirSync(manifestDirectory).includes("successor.json"));
  }finally{f.dispose();}
});
test("proof substitution during the eligibility guard cannot publish a different restoration lineage",async()=>{
  const f=fixture();try{
    const original=f.host.fallback;let changed=false;
    f.host.fallback=async root=>{if(f.state.extract>0)changed=true;return original(root);};
    f.host.restored=()=>changed?{...f.proof,identity:{...f.proof.identity,ino:"21"}}:f.proof;
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host),/pinned lineage must remain exact/);
    const row=readReservations(f.root)[0]!,directory=join(row.missingRecovery!.manifest,".."),phases=readdirSync(directory).filter(name=>/^\d{6}\.json$/.test(name)).map(name=>JSON.parse(readFileSync(join(directory,name),"utf8")).body.phase);
    assert.ok(!phases.includes("restoration-verified"));assert.equal(row.state,"partial");assert.equal(f.state.detach,0);
  }finally{f.dispose();}
});
test("resume after registry retirement CAS validates the exact retired entry and appends reconciliation",async()=>{
  const f=fixture();try{const old=readFileSync(f.receipt);
    f.host.afterRetirementCAS=()=>{throw new Error("Interrupted after registry retirement CAS");};
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host),/Interrupted after registry retirement CAS/);
    const row=readReservations(f.root)[0]!,transactionId=row.missingRecovery!.transactionId,directory=join(row.missingRecovery!.manifest,".."),names=readdirSync(directory).filter(name=>/^\d{6}\.json$/.test(name)).sort();
    assert.equal(row.state,"retired");assert.equal(JSON.parse(readFileSync(join(directory,names.at(-1)!),"utf8")).body.phase,"disposition-verified");
    const registry=readFileSync(join(f.root,"local-artifact-reservations.json"));f.host.afterRetirementCAS=undefined;
    const resumed=await recoverMissingArtifact(f.root,f.id,{apply:true,transactionId},f.host);
    assert.equal(resumed.phase,"reconciled");assert.equal(f.state.create,1);assert.equal(f.state.extract,1);assert.equal(f.state.detach,1);
    assert.deepEqual(readFileSync(join(f.root,"local-artifact-reservations.json")),registry);assert.deepEqual(readFileSync(f.receipt),old);
  }finally{f.dispose();}
});
test("retired missing-recovery lineage preserves the pinned owner outside the newest 100 terminal results",async()=>{
  const f=fixture();try{
    await recoverMissingArtifact(f.root,f.id,{apply:true},f.host);const row=readReservations(f.root)[0]!,operationRoot=join(f.root,"local-operation"),ownerPath=join(operationRoot,`result-${row.operationId}.json`);
    assert.equal(row.state,"retired");assert.ok(row.missingRecovery);
    for(let index=0;index<101;index++) {const id=randomUUID();write(join(operationRoot,`result-${id}.json`),{version:1,id,state:"completed",pid:999998,kind:"old fixture result",startedAt:new Date(Date.UTC(2021,0,1,index)).toISOString(),children:[]});}
    const retained=await maintainTerminalOperationResults(operationRoot,false);
    assert.ok(retained.retained.includes(ownerPath));assert.ok(!retained.eligible.includes(ownerPath));assert.ok(retained.eligible.length>0);
    const manifest=JSON.parse(readFileSync(row.missingRecovery!.manifest,"utf8")).body as RecoveryManifest;
    assert.equal(manifest.operation.sha256,digest(readFileSync(ownerPath,"utf8")));
  }finally{f.dispose();}
});
test("detached image drift during final archive validation blocks successor publication and retirement",async()=>{
  const f=fixture();try{const archive=f.host.archive,identity=f.host.fileIdentity;let changed=false;
    f.host.archive=async manifest=>{
      await archive(manifest);
      const row=readReservations(f.root)[0]!;if(row.missingRecovery) {
        const directory=join(row.missingRecovery.manifest,".."),names=readdirSync(directory).filter(name=>/^\d{6}\.json$/.test(name)).sort();
        if(names.length&&JSON.parse(readFileSync(join(directory,names.at(-1)!),"utf8")).body.phase==="disposition-verified")changed=true;
      }
    };
    f.host.fileIdentity=path=>changed&&path.endsWith(".missing-restore.sparseimage")?{dev:"3",ino:"51"}:identity(path);
    await assert.rejects(recoverMissingArtifact(f.root,f.id,{apply:true},f.host),/Detached image disposition changed/);
    const row=readReservations(f.root)[0]!;assert.equal(row.state,"partial");assert.equal(f.state.mounted,false);
    assert.ok(!readdirSync(join(row.missingRecovery!.manifest,"..")).includes("successor.json"));
  }finally{f.dispose();}
});

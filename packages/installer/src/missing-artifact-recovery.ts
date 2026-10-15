/** Missing-payload recovery never claims that the historical Trash move happened. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, constants, closeSync, createReadStream, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import plist from "plist";
import { acquireProcessLock, processIdentityAlive } from "./process-lock.js";
import { localOperationProcessGroupAlive, withLocalOperation, type LocalOperationRecord } from "./local-operation.js";
import { lifecycleLockFile, withLifecycleLock } from "./lifecycle-lock-core.js";
import { bindMissingArtifactRecovery, inspectLocalArtifactCapacity, readReservations, reconcileMissingArtifactRecovery, type ArtifactReservation } from "./local-artifacts.js";
import { assertArchiveVolume, readArtifactRetentionPolicy, restorationMetadata } from "./artifact-retirement.js";
import { sealOfficialSourceTree } from "./official-source-registration.js";
import { restoreSealedArchiveFileContents, sealArchiveTree } from "./doctor-baseline.js";
import { fingerprintVariantGeneration, type VariantGenerationFingerprint } from "./variant-generation.js";
import { historicalDaemonOutsidePublicationScope, parseHistoricalLaunchServices } from "./manager-historical-continuations.js";
import type { TweakersManagerDescriptorPaths, TweakersManagerGenerationRecord } from "./manager-descriptor.js";

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
export const recoveryCanonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item && typeof item==="object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const equal=(a:unknown,b:unknown)=>recoveryCanonical(a)===recoveryCanonical(b);
function requireThat(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
interface Seal {sha256:string;entries:number;bytes:string;}
interface Ref {path:string;sha256:string;}
export interface Identity {dev:string;ino:string;}
export interface FileSnapshot extends Identity {size:string;mtimeNs:string;ctimeNs:string;mode:string;uid:string;nlink:string;}
interface OldReceipt {
  version:1;metadataVersion:1;phase:string;reservationId:string;journalId:string;journalSha256:string;
  original:string;trash:string;archive:string;archiveSHA256:string;archiveVolume:string;volumeUUID:string;
  originalIdentity:{dev:number;ino:number};originalSeal:Seal;originalMetadata:unknown;fallback:unknown;
  restorationVerified:boolean;retired:boolean;reservationReconciled:boolean;proofImage:string;proofImageIdentity:{dev:number;ino:number};proofImageDetached:boolean;
  archiveIdentityCorrection:Ref;
  moveState:{phase:"prepared";entries:Array<{original:string;trash:string;phase:"prepared"|"moved"}>};
  consumerCensus?:unknown;
}
export interface RecoveryManifest {
  version:1;kind:"missing-artifact-recovery";id:string;reservation:ArtifactReservation;
  receipt:Ref;correction:Ref;journal:Ref;operation:Ref;old:OldReceipt;
  archiveSnapshot:FileSnapshot;archiveParent:Identity;allocation:NonNullable<ArtifactReservation["missingRecovery"]>["proof"];
}
export type RecoveryPhase="prepared"|"restoring"|"restoration-verified"|"detaching"|"disposition-verified"|"reconciled";
export interface RestoredProof {identity:Identity;seal:Seal;metadata:unknown;fingerprint:VariantGenerationFingerprint;}
export interface RecoveryTransition {
  version:1;transactionId:string;sequence:number;previousSHA256:string;phase:RecoveryPhase;
  imageIdentity?:Identity;restored?:RestoredProof;
  imageSnapshot?:FileSnapshot;
}
interface Envelope<T> {version:1;body:T;sha256:string;}
export interface RecoveryResult {eligible:true;applied:boolean;transactionId:string|null;phase:RecoveryPhase|null;receipt?:string;}
export interface RecoveryOptions {apply?:boolean;transactionId?:string;}
/** Inject OS observations in fixture tests; production uses the fail-closed adapter below. */
export interface RecoveryHost {
  archive(manifest:RecoveryManifest):Promise<void>;
  fileSnapshot(path:string):FileSnapshot;
  fileIdentity(path:string):Identity;
  allocationAbsent(path:string):boolean;
  space(manifest:RecoveryManifest):void;
  capacity(root:string):{occupied:number;blockers:string[]};
  volume(volume:string,uuid:string):void;
  fallback(root:string):Promise<unknown>;
  consumers(root:string,targets:string[],owner:LocalOperationRecord):void;
  imageMappings():Array<{image:string;mounts:string[]}>;
  mountBoundary(mount:string):void;
  createImage(path:string,size:string):void;
  attach(image:string,mount:string):void;
  extract(manifest:RecoveryManifest):void;
  restored(manifest:RecoveryManifest):RestoredProof;
  detach(mount:string):void;
  reserveAdmission(root:string):Promise<{release():Promise<void>}>;
  withLocks<T>(root:string,run:()=>Promise<T>):Promise<T>;
  /** Fixture interruption boundary; production has no hook. */
  afterRetirementCAS?():void;
}
/** Fixture seams replace observations, never the fixed current-generation import path. */
export interface RecoveryManagerAdmissionDependencies {
  canonicalRoot():string;
  descriptorPaths(root:string):Pick<TweakersManagerDescriptorPaths,"userRoot"|"managerRoot"|"generationsRoot">;
  readCurrent(root:string):TweakersManagerGenerationRecord["current"];
  verifyRetained(generationId:string):{generationId:string;sealSha256:string;moduleRoot:string;runtimeRoot:string};
  importBundle(url:string):Promise<unknown>;
}
/** Ordinary source has no compiled runtime binding. Reuse only the authoritative
 * current sealed Manager's operator export; importing it does not dispatch its CLI. */
export async function reserveCurrentSealedManagerRecoveryAdmission(root:string,dependencies?:RecoveryManagerAdmissionDependencies):Promise<{release():Promise<void>}> {
  if(!dependencies) {
    const descriptor=await import("./manager-descriptor.js");
    dependencies={canonicalRoot:descriptor.canonicalTweakersManagerRoot,
      descriptorPaths:descriptor.tweakersManagerDescriptorPaths,
      readCurrent:value=>descriptor.readTweakersManagerGenerationRecord(value).current,
      verifyRetained:descriptor.verifyRetainedTweakersManagerGeneration,
      importBundle:url=>import(url)};
  }
  requireThat(root===dependencies.canonicalRoot()&&realpathSync(root)===root,"Recovery admission requires the canonical Manager root");
  const pinned=structuredClone(dependencies.readCurrent(root));
  for(const field of ["generationId","sealSha256","runtimeFingerprint","managedRuntimeFingerprint"] as const)
    requireThat(HEX.test(pinned[field]),"Invalid current Manager generation binding");
  const paths=dependencies.descriptorPaths(root),managerRoot=paths.managerRoot;
  requireThat(paths.userRoot===root,"Current Manager descriptor paths changed recovery root");
  const expected={generationId:pinned.generationId,sealSha256:pinned.sealSha256,
    moduleRoot:join(managerRoot,"managed-runtime-generations",pinned.managedRuntimeFingerprint,"packages","installer","dist"),
    runtimeRoot:join(managerRoot,"runtime-generations",pinned.runtimeFingerprint)};
  const assertCurrent=():void=>{
    requireThat(equal(dependencies!.readCurrent(root),pinned),"Current Manager generation changed during recovery admission");
    requireThat(equal(dependencies!.verifyRetained(pinned.generationId),expected),"Current Manager sealed runtime binding changed");
  };
  assertCurrent();
  const bundle=join(paths.generationsRoot,pinned.generationId,"manager.mjs");
  const imported=await dependencies.importBundle(pathToFileURL(bundle).href);
  assertCurrent();
  const reserve=imported&&typeof imported==="object"?(imported as Record<string,unknown>).reserveClosedIndependentTweakersCutover:undefined;
  requireThat(typeof reserve==="function","Current sealed Manager lacks the recovery admission guard");
  const admission=await (reserve as ()=>Promise<{release():Promise<void>}>)();
  requireThat(admission&&typeof admission.release==="function","Current sealed Manager returned invalid recovery admission");
  try {assertCurrent();}
  catch(error) {
    try {await admission.release();}
    catch(releaseError) {throw new AggregateError([error,releaseError],"Manager recovery admission changed and releasing admission failed");}
    throw error;
  }
  let released=false;
  return {async release(){if(released)return;released=true;await admission.release();}};
}
function snapshot(path:string):FileSnapshot {
  requireThat(realpathSync(path)===path,"Noncanonical recovery evidence");
  const st=lstatSync(path,{bigint:true});requireThat(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1n,"Unsafe recovery file identity");
  return Object.fromEntries(["dev","ino","size","mtimeNs","ctimeNs","mode","uid","nlink"].map(k=>[k,String(st[k as keyof typeof st])])) as unknown as FileSnapshot;
}
function identity(path:string):Identity {const st=lstatSync(path,{bigint:true});requireThat(!st.isSymbolicLink()&&realpathSync(path)===path,"Unsafe recovery identity");return {dev:String(st.dev),ino:String(st.ino)};}
function absent(path:string):boolean {try{lstatSync(path);return false;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return true;throw error;}}
function safeText(path:string):string {
  const before=snapshot(path);requireThat(before.uid===String(process.getuid?.())&&(BigInt(before.mode)&0o077n)===0n&&BigInt(before.size)<=4n*1024n*1024n,"Unsafe private recovery evidence");
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const opened=fstatSync(fd,{bigint:true});requireThat(String(opened.dev)===before.dev&&String(opened.ino)===before.ino,"Recovery evidence changed during open");
    const text=readFileSync(fd,"utf8");requireThat(equal(snapshot(path),before),"Recovery evidence changed during read");return text;
  }finally{closeSync(fd);}
}
function ref(path:string):Ref {return {path,sha256:hash(safeText(path))};}
function readEnvelope<T>(path:string):Envelope<T> {
  const text=safeText(path),value=JSON.parse(text) as Envelope<T>;
  requireThat(value.version===1&&HEX.test(value.sha256)&&hash(recoveryCanonical(value.body))===value.sha256
    && Object.keys(value).sort().join(",")==="body,sha256,version","Invalid immutable recovery envelope");return value;
}
function syncDirectory(path:string):void {const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
/** No replacement: numbered transitions and the manifest are durable immutable inputs. */
function publish<T>(path:string,body:T):Envelope<T> {
  const value:Envelope<T>={version:1,body,sha256:hash(recoveryCanonical(body))};
  if(!absent(path)){requireThat(equal(readEnvelope(path),value),"Conflicting recovery publication");return value;}
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,recoveryCanonical(value)+"\n");fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(dirname(path));return value;
}
function recoveryDirectory(root:string,id:string):string {requireThat(UUID.test(id),"Invalid recovery transaction UUID");return join(root,"artifact-archives/missing-artifact-recovery",id);}
function steps(root:string,manifest:RecoveryManifest):Envelope<RecoveryTransition>[] {
  const directory=recoveryDirectory(root,manifest.id),names=readdirSync(directory).filter(name=>/^\d{6}\.json$/.test(name)).sort();
  const chain:Envelope<RecoveryTransition>[]=[];let previous=hash(recoveryCanonical(manifest));
  const order:RecoveryPhase[]=["prepared","restoring","restoration-verified","detaching","disposition-verified","reconciled"];
  for(const [index,name]of names.entries()) {
    requireThat(name===`${String(index).padStart(6,"0")}.json`,"Recovery transition gap");
    const entry=readEnvelope<RecoveryTransition>(join(directory,name)),body=entry.body;
    requireThat(body.version===1&&body.transactionId===manifest.id&&body.sequence===index&&body.previousSHA256===previous,"Recovery transition chain changed");
    const prior=chain.at(-1)?.body.phase,position=order.indexOf(body.phase);
    requireThat(position>=0&&(prior===undefined?body.phase==="prepared":position===order.indexOf(prior)||position===order.indexOf(prior)+1),"Invalid recovery phase transition");
    const before=chain.at(-1)?.body;
    if(before?.imageIdentity)requireThat(equal(before.imageIdentity,body.imageIdentity),"Pinned image identity changed in transition");
    if(before?.restored)requireThat(equal(before.restored,body.restored),"Restoration lineage changed in transition");
    if(before?.imageSnapshot)requireThat(equal(before.imageSnapshot,body.imageSnapshot),"Detached proof image snapshot changed in transition");
    chain.push(entry);previous=entry.sha256;
  }return chain;
}
function append(root:string,manifest:RecoveryManifest,phase:RecoveryPhase,proof:Partial<Pick<RecoveryTransition,"imageIdentity"|"restored"|"imageSnapshot">>={}):void {
  const chain=steps(root,manifest),last=chain.at(-1),sequence=chain.length;
  publish(join(recoveryDirectory(root,manifest.id),`${String(sequence).padStart(6,"0")}.json`),{
    version:1,transactionId:manifest.id,sequence,previousSHA256:last?.sha256??hash(recoveryCanonical(manifest)),phase,
    ...(last?.body.imageIdentity?{imageIdentity:last.body.imageIdentity}:{}),...(last?.body.restored?{restored:last.body.restored}:{}),...(last?.body.imageSnapshot?{imageSnapshot:last.body.imageSnapshot}:{}),...proof} satisfies RecoveryTransition);
}
function checkCorrection(old:OldReceipt,path:string):{snapshot:FileSnapshot;parent:Identity} {
  requireThat(path===old.archiveIdentityCorrection.path,"Archive correction location changed");
  const envelope=readEnvelope<Record<string,unknown>>(path),body=envelope.body;
  requireThat(envelope.sha256===old.archiveIdentityCorrection.sha256&&body.archive===old.archive&&body.archiveSHA256===old.archiveSHA256
    &&body.volumeUUID===old.volumeUUID&&body.restorationVerified===true&&equal(body.proofImageIdentity,old.proofImageIdentity),"Archive correction binding changed");
  requireThat(typeof body.priorReceiptText==="string"&&hash(body.priorReceiptText)===body.priorReceiptSHA256,"Archive correction prior receipt changed");
  const prior=JSON.parse(body.priorReceiptText) as OldReceipt;
  if(old.consumerCensus!==undefined) {
    const census=old.consumerCensus as {at?:unknown;loaded?:unknown;persisted?:unknown;excluded?:unknown};
    requireThat(census&&Object.keys(census).sort().join(",")==="at,excluded,loaded,persisted"&&typeof census.at==="string"
      &&Array.isArray(census.loaded)&&Array.isArray(census.persisted)&&Array.isArray(census.excluded),"Historical consumer census shape changed");
  }
  requireThat(prior.moveState?.phase==="prepared"&&prior.moveState.entries.length===1
    &&equal(prior.moveState.entries[0],{original:old.original,trash:old.trash,phase:"prepared"})
    &&old.moveState?.phase==="prepared"&&old.moveState.entries.length===1
    &&["prepared","moved"].includes(old.moveState.entries[0]!.phase)
    &&equal({...old.moveState.entries[0],phase:"prepared"},prior.moveState.entries[0]),"Historical move journal shape changed");
  // The old operator persisted a census and a move-intent result after the
  // immutable correction. Neither proves today's absent Trash disposition.
  requireThat(equal({...old,archiveIdentityCorrection:undefined,consumerCensus:undefined,moveState:prior.moveState},prior),"Original receipt differs from correction lineage");
  const finalized=body.finalSnapshot as FileSnapshot,parent=body.parentIdentity as Identity;
  requireThat(finalized&&parent&&equal(body.finalIdentity,{dev:finalized.dev,ino:finalized.ino})
    &&Object.values(finalized).every(v=>typeof v==="string"&&/^\d+$/.test(v))
    &&[parent.dev,parent.ino].every(v=>typeof v==="string"&&/^\d+$/.test(v)),"Exact archive correction identity missing");
  return {snapshot:finalized,parent};
}
function checkManifest(root:string,manifest:RecoveryManifest):LocalOperationRecord {
  const old=manifest.old,reservation=manifest.reservation;
  requireThat(manifest.version===1&&manifest.kind==="missing-artifact-recovery"&&UUID.test(manifest.id)
    &&reservation.state==="partial"&&UUID.test(reservation.id)&&reservation.transactionRef===manifest.journal.path
    &&reservation.paths.length===1&&reservation.paths[0]===old.original&&reservation.operationId&&reservation.ownerPid&&reservation.ownerStartedAt
    &&equal(reservation.generationIdentity,old.originalIdentity)&&old.version===1&&old.metadataVersion===1
    &&old.phase==="verified"&&old.retired===false&&old.reservationReconciled===false&&old.restorationVerified===true
    &&old.proofImageDetached===true&&old.reservationId===reservation.id&&UUID.test(old.journalId)
    &&old.original===join(root,"variants/tweakers/builds",old.journalId,"failed-promotion/app/Tweakers.app")
    &&manifest.journal.path===join(root,"variants/tweakers/transactions/variant-promotion",`${old.journalId}.json`)
    &&old.archiveVolume==="/Volumes/SHOWS DB"&&typeof old.volumeUUID==="string"&&old.volumeUUID.length>0
    &&old.originalMetadata&&HEX.test(old.originalSeal?.sha256)&&HEX.test(old.archiveSHA256)
    &&old.archive===join(old.archiveVolume,"_Mac-Archive/Tweakers/failed-promotions",`${old.journalId}-${basename(manifest.receipt.path,".json")}.tar`)
    &&manifest.receipt.path===join(root,"artifact-archives/failed-promotion-retirement",basename(manifest.receipt.path))
    &&old.trash===join(homedir(),".Trash",`Tweakers-failed-promotion-${basename(manifest.receipt.path,".json")}`)
    &&old.proofImage===join(dirname(old.archive),`${basename(manifest.receipt.path,".json")}.restore.sparseimage`),"Missing artifact recovery is ineligible");
  requireThat(manifest.operation.path===join(root,"local-operation",`result-${reservation.operationId}.json`),"Terminal operation path changed");
  for(const reference of [manifest.receipt,manifest.correction,manifest.journal,manifest.operation])requireThat(HEX.test(reference.sha256)&&ref(reference.path).sha256===reference.sha256,"Pinned recovery input changed");
  const journal=JSON.parse(safeText(manifest.journal.path)),app=journal.entries?.find((entry:{name:string})=>entry.name==="app");
  requireThat(journal.version===3&&journal.id===old.journalId&&journal.phase==="recovered"&&hash(safeText(manifest.journal.path))===old.journalSha256
    &&app?.failed===old.original&&equal(app.desired,reservation.generationFingerprint),"Recovered promotion journal changed");
  const owner=JSON.parse(safeText(manifest.operation.path)) as LocalOperationRecord;
  requireThat(owner.version===1&&owner.id===reservation.operationId&&["completed","failed"].includes(owner.state)
    &&Number.isSafeInteger(owner.pid)&&owner.pid>1&&owner.pid===reservation.ownerPid&&owner.processStartedAt===reservation.ownerStartedAt
    &&(owner.children===undefined||Array.isArray(owner.children)&&owner.children.every(child=>Number.isSafeInteger(child.pid)&&child.pid>1
      &&child.processGroup===child.pid&&typeof child.processStartedAt==="string"&&child.processStartedAt.length>0&&typeof child.command==="string")),"Exact terminal operation unavailable");
  requireThat(equal(checkCorrection(old,manifest.correction.path),{snapshot:manifest.archiveSnapshot,parent:manifest.archiveParent}),"Archive correction changed");
  const expected={kind:"private-apfs-verification-image",image:join(dirname(old.archive),`${manifest.id}.missing-restore.sparseimage`),mount:join("/Volumes",`TweakersArchiveVerify-${manifest.id}`)};
  requireThat(equal(manifest.allocation,expected),"Recovery allocation changed");return owner;
}
async function guard(root:string,manifest:RecoveryManifest,host:RecoveryHost):Promise<void> {
  const owner=checkManifest(root,manifest),old=manifest.old;
  requireThat(absent(old.original)&&absent(old.trash),"Original or historical Trash payload reappeared");
  host.volume(old.archiveVolume,old.volumeUUID);
  requireThat(equal(host.fileIdentity(dirname(old.archive)),manifest.archiveParent),"Archive parent identity changed");
  requireThat(equal(host.fileSnapshot(old.archive),manifest.archiveSnapshot),"Archive identity changed");
  requireThat(equal(host.fileIdentity(old.proofImage),{dev:String(old.proofImageIdentity.dev),ino:String(old.proofImageIdentity.ino)})
    &&!host.imageMappings().some(row=>row.image===old.proofImage),"Historical restoration proof changed or is attached");
  requireThat(equal(await host.fallback(root),old.fallback),"Installed fallback changed");
  const attached=host.imageMappings().some(row=>row.image===manifest.allocation.image);
  host.consumers(root,[old.original,old.trash,...(attached?[]:[manifest.allocation.image]),manifest.allocation.mount,old.journalId],owner);
  const capacity=host.capacity(root);
  requireThat(!capacity.blockers.length&&capacity.occupied<=2,"Recovery capacity blocked");
}
function assertMapping(manifest:RecoveryManifest,host:RecoveryHost,allowDetached:boolean):boolean {
  const all=host.imageMappings(),matches=all.filter(row=>row.image===manifest.allocation.image);
  requireThat(!all.some(row=>row.image!==manifest.allocation.image&&row.mounts.includes(manifest.allocation.mount)),"Recovery mount belongs to another image");
  requireThat(matches.length<=1&&(!matches.length?allowDetached:equal(matches[0]!.mounts,[manifest.allocation.mount])),"Recovery image mapping changed");
  if(matches.length)host.mountBoundary(manifest.allocation.mount);else requireThat(absent(manifest.allocation.mount)||readdirSync(manifest.allocation.mount).length===0,"Detached recovery mount has remaining contents");
  return matches.length>0;
}
function assertRestored(manifest:RecoveryManifest,proof:RestoredProof):void {
  requireThat(equal(proof.seal,manifest.old.originalSeal)&&equal(proof.metadata,manifest.old.originalMetadata)
    &&equal(proof.fingerprint,manifest.reservation.generationFingerprint)
    &&!equal(proof.identity,{dev:String(manifest.old.originalIdentity.dev),ino:String(manifest.old.originalIdentity.ino)}),"Restoration fingerprint, metadata or new lineage failed");
}
function assertPinnedRestoration(manifest:RecoveryManifest,host:RecoveryHost,pinned:RestoredProof|undefined):void {
  requireThat(pinned,"Verified restoration has no pinned proof");
  const live=host.restored(manifest);assertRestored(manifest,live);
  requireThat(equal(live,pinned),"Restored proof changed after verification; pinned lineage must remain exact");
}
function assertDetachedDisposition(manifest:RecoveryManifest,host:RecoveryHost,transition:RecoveryTransition):void {
  requireThat(transition.imageIdentity&&transition.imageSnapshot
    &&equal(host.fileIdentity(manifest.allocation.image),transition.imageIdentity)
    &&equal(host.fileSnapshot(manifest.allocation.image),transition.imageSnapshot)
    &&!assertMapping(manifest,host,true),"Detached image disposition changed");
}
export function validateMissingArtifactSuccessor(root:string,manifest:RecoveryManifest,path:string):void {
  requireThat(path===join(recoveryDirectory(root,manifest.id),"successor.json"),"Successor receipt location changed");
  const receipt=readEnvelope<Record<string,unknown>>(path).body,chain=steps(root,manifest),last=chain.at(-1)?.body;
  requireThat(last&&["disposition-verified","reconciled"].includes(last.phase)&&last.restored&&last.imageIdentity&&last.imageSnapshot,"Successor has no disposition proof");
  assertRestored(manifest,last.restored);
  requireThat(receipt.version===1&&receipt.kind==="missing-artifact-successor"&&receipt.transactionId===manifest.id&&receipt.reservationId===manifest.reservation.id
    &&receipt.historicalTrashMove==="unknown"&&receipt.originalReceiptUnchanged===true&&equal(receipt.originalReceipt,manifest.receipt)
    &&equal(receipt.correction,manifest.correction)&&equal(receipt.archiveSnapshot,manifest.archiveSnapshot)
    &&equal(receipt.lineage,{historical:manifest.old.originalIdentity,restored:last.restored.identity})
    &&equal(receipt.proofImage,{...manifest.allocation,identity:last.imageIdentity,snapshot:last.imageSnapshot,detached:true})
    &&equal(receipt.restoration,last.restored)&&receipt.archiveSHA256===manifest.old.archiveSHA256,"Invalid missing artifact successor receipt");
}
export async function recoverMissingArtifact(root:string,reservationId:string,options:RecoveryOptions={},host:RecoveryHost=productionRecoveryHost):Promise<RecoveryResult> {
  requireThat(UUID.test(reservationId)&&(!options.transactionId||UUID.test(options.transactionId)),"Exact reservation and transaction UUID required");
  requireThat(realpathSync(root)===root,"Recovery root must be canonical");
  let entry=readReservations(root).find(row=>row.id===reservationId);requireThat(entry,"Reservation not found");
  const transactionId=options.transactionId??entry.missingRecovery?.transactionId;
  let manifest:RecoveryManifest;
  if(transactionId) {
    manifest=readEnvelope<RecoveryManifest>(join(recoveryDirectory(root,transactionId),"input.json")).body;
    requireThat(manifest.reservation.id===reservationId,"Transaction belongs to another reservation");
  } else {
    requireThat(entry.state==="partial"&&!entry.missingRecovery,"Reservation requires explicit recovery");
    const receipts=join(root,"artifact-archives/failed-promotion-retirement");
    const matching=readdirSync(receipts).filter(name=>UUID.test(name.replace(/\.json$/,""))&&name.endsWith(".json"))
      .map(name=>({path:join(receipts,name),body:JSON.parse(safeText(join(receipts,name))) as OldReceipt})).filter(row=>row.body.reservationId===reservationId);
    requireThat(matching.length===1,"Exactly one verified historical receipt is required");
    const {path,body:old}=matching[0]!,correction=checkCorrection(old,old.archiveIdentityCorrection.path),id=randomUUID();
    requireThat(entry.transactionRef&&entry.operationId,"Missing exact reservation provenance");
    manifest={version:1,kind:"missing-artifact-recovery",id,reservation:entry,receipt:ref(path),correction:ref(old.archiveIdentityCorrection.path),
      journal:ref(entry.transactionRef),operation:ref(join(root,"local-operation",`result-${entry.operationId}.json`)),old,
      archiveSnapshot:correction.snapshot,archiveParent:correction.parent,
      allocation:{kind:"private-apfs-verification-image",image:join(dirname(old.archive),`${id}.missing-restore.sparseimage`),mount:join("/Volumes",`TweakersArchiveVerify-${id}`)}};
  }
  await guard(root,manifest,host);await host.archive(manifest);
  if(!options.apply)return {eligible:true,applied:false,transactionId:transactionId??null,phase:transactionId?steps(root,manifest).at(-1)?.body.phase??null:null};
  return host.withLocks(root,async()=>{
    const admission=await host.reserveAdmission(root);
    try {
      await guard(root,manifest,host);
      entry=readReservations(root).find(row=>row.id===reservationId);requireThat(entry,"Reservation disappeared");
      const directory=recoveryDirectory(root,manifest.id),manifestPath=join(directory,"input.json");
      if(entry.missingRecovery)requireThat(entry.missingRecovery.transactionId===manifest.id&&entry.missingRecovery.manifest===manifestPath
        &&entry.missingRecovery.manifestSHA256===hash(recoveryCanonical(manifest))&&equal({...entry,missingRecovery:undefined,state:"partial",retiredReceipt:undefined},manifest.reservation)
        &&(entry.state==="partial"||(entry.state==="retired"&&entry.retiredReceipt===join(directory,"successor.json"))),"Recovery reservation CAS changed");
      else {
        requireThat(equal(entry,manifest.reservation)&&host.allocationAbsent(manifest.allocation.image)&&host.allocationAbsent(manifest.allocation.mount),"Recovery allocation conflicts");
        mkdirSync(directory,{recursive:true,mode:0o700});
        const directoryStat=lstatSync(directory);requireThat(realpathSync(directory)===directory&&directoryStat.isDirectory()
          &&directoryStat.uid===process.getuid?.()&&!(directoryStat.mode&0o077),"Recovery transaction directory is unsafe");
        publish(manifestPath,manifest);
        entry=bindMissingArtifactRecovery(root,entry,{transactionId:manifest.id,manifest:manifestPath,manifestSHA256:hash(recoveryCanonical(manifest)),proof:manifest.allocation});
      }
      let last=steps(root,manifest).at(-1)?.body;
      if(!last){append(root,manifest,"prepared");last=steps(root,manifest).at(-1)!.body;}
      if(last.phase==="prepared") {
        requireThat(host.allocationAbsent(manifest.allocation.image)&&host.allocationAbsent(manifest.allocation.mount),"Unbound proof image creation requires explicit evidence recovery; no new allocation permitted");
        host.space(manifest);
        // Publish intent before hdiutil. An unbound image after interruption is
        // retained and blocks: no inode or provenance is invented on resume.
        append(root,manifest,"restoring");host.createImage(manifest.allocation.image,`${Math.ceil(Number(manifest.old.originalSeal.bytes)/1024**3)+2}g`);
        append(root,manifest,"restoring",{imageIdentity:host.fileIdentity(manifest.allocation.image)});last=steps(root,manifest).at(-1)!.body;
      }
      if(last.phase==="restoring") {
        requireThat(last.imageIdentity&&equal(host.fileIdentity(manifest.allocation.image),last.imageIdentity),"Unbound or changed recovery image; retained allocation requires evidence recovery");
        if(!assertMapping(manifest,host,true))host.attach(manifest.allocation.image,manifest.allocation.mount);
        assertMapping(manifest,host,false);await guard(root,manifest,host);await host.archive(manifest);
        host.extract(manifest);const restored=host.restored(manifest);assertRestored(manifest,restored);
        await guard(root,manifest,host);assertPinnedRestoration(manifest,host,restored);
        append(root,manifest,"restoration-verified",{restored});last=steps(root,manifest).at(-1)!.body;
      }
      if(last.phase==="restoration-verified") {
        requireThat(last.imageIdentity&&equal(host.fileIdentity(manifest.allocation.image),last.imageIdentity),"Recovery image changed");
        requireThat(assertMapping(manifest,host,false),"Verified restoration detached before disposition intent");
        assertPinnedRestoration(manifest,host,last.restored);await guard(root,manifest,host);
        assertPinnedRestoration(manifest,host,last.restored);
        append(root,manifest,"detaching");last=steps(root,manifest).at(-1)!.body;
      }
      if(last.phase==="detaching") {
        requireThat(last.imageIdentity&&equal(host.fileIdentity(manifest.allocation.image),last.imageIdentity),"Recovery image changed before detach");
        if(assertMapping(manifest,host,true)) {
          assertPinnedRestoration(manifest,host,last.restored);await guard(root,manifest,host);
          assertPinnedRestoration(manifest,host,last.restored);host.detach(manifest.allocation.mount);
        }
        requireThat(!assertMapping(manifest,host,true),"Recovery image still attached");await guard(root,manifest,host);await host.archive(manifest);
        requireThat(equal(host.fileIdentity(manifest.allocation.image),last.imageIdentity),"Recovery image identity changed during disposition");
        append(root,manifest,"disposition-verified",{imageSnapshot:host.fileSnapshot(manifest.allocation.image)});last=steps(root,manifest).at(-1)!.body;
      }
      const receipt=join(directory,"successor.json");
      if(last.phase==="disposition-verified") {
        const disposition=last;
        requireThat(last.restored,"Disposition has no pinned restoration");assertDetachedDisposition(manifest,host,last);
        await guard(root,manifest,host);await host.archive(manifest);
        assertDetachedDisposition(manifest,host,last);
        publish(receipt,{version:1,kind:"missing-artifact-successor",transactionId:manifest.id,reservationId,
          historicalTrashMove:"unknown",originalReceiptUnchanged:true,originalReceipt:manifest.receipt,correction:manifest.correction,
          archiveSnapshot:manifest.archiveSnapshot,archiveSHA256:manifest.old.archiveSHA256,
          lineage:{historical:manifest.old.originalIdentity,restored:last.restored.identity},restoration:last.restored,
          proofImage:{...manifest.allocation,identity:last.imageIdentity,snapshot:last.imageSnapshot,detached:true}});
        validateMissingArtifactSuccessor(root,manifest,receipt);
        const current=readReservations(root).find(row=>row.id===reservationId)!;
        if(current.state!=="retired")reconcileMissingArtifactRecovery(root,entry,receipt,()=>{
          checkManifest(root,manifest);requireThat(absent(manifest.old.original)&&absent(manifest.old.trash)&&!assertMapping(manifest,host,true),"Disposition changed during CAS");
          assertDetachedDisposition(manifest,host,disposition);
          validateMissingArtifactSuccessor(root,manifest,receipt);
        });else requireThat(equal(current,{...manifest.reservation,missingRecovery:entry.missingRecovery,state:"retired",retiredReceipt:receipt}),"Retired reservation changed");
        host.afterRetirementCAS?.();
        append(root,manifest,"reconciled");
      }
      assertDetachedDisposition(manifest,host,last);
      validateMissingArtifactSuccessor(root,manifest,receipt);
      return {eligible:true,applied:true,transactionId:manifest.id,phase:"reconciled",receipt};
    } finally {await admission.release();}
  });
}

function run(command:string,args:string[],input?:string):string {
  const env={...process.env,LC_ALL:"C"};if(command==="/usr/bin/tar")delete (env as NodeJS.ProcessEnv).COPYFILE_DISABLE;
  return execFileSync(command,args,{env,input,encoding:"utf8",stdio:[input===undefined?"ignore":"pipe","pipe","pipe"],timeout:120_000,maxBuffer:16*1024*1024});
}
function references(text:string,targets:string[]):boolean {
  const forms=[text];try {const visit=(item:unknown):void=>{if(typeof item==="string")forms.push(item);else if(Array.isArray(item))item.forEach(visit);else if(item&&typeof item==="object")Object.values(item).forEach(visit);};visit(JSON.parse(text));}catch{/* Commands and plists need not be JSON. */}
  return forms.some(form=>targets.some(target=>form.includes(target)||form.replace(/\\(.)/gs,"$1").replace(/['"]/g,"").includes(target)));
}
function canAccess(path:string,mode:number):boolean {try{accessSync(path,mode);return true;}catch(error){if(["EPERM","EACCES"].includes((error as NodeJS.ErrnoException).code??""))return false;throw error;}}
function assertConsumers(root:string,targets:string[],owner:LocalOperationRecord):void {
  requireThat(process.platform==="darwin","Recovery consumer census requires macOS");
  requireThat(!processIdentityAlive(owner.pid,owner.processStartedAt),"Terminal owner is still alive");
  for(const child of owner.children??[])requireThat(!processIdentityAlive(child.pid,child.processStartedAt)&&!localOperationProcessGroupAlive(child.processGroup),"Terminal owner descendants are still alive");
  // Raw commands and environment are examined in memory and never persisted.
  requireThat(!references(run("/bin/ps",["-ww","-axo","command="]),targets),"Recovery payload has process consumers");
  const uid=process.getuid?.();requireThat(uid!==undefined,"Recovery user identity unavailable");
  for(const domain of [`gui/${uid}`,`user/${uid}`,"system"])for(const service of parseHistoricalLaunchServices(run("/bin/launchctl",["print",domain]),domain)) {
    const name=`${domain}/${service}`,detail=run("/bin/launchctl",["print",name]);
    requireThat(detail.startsWith(`${name} = {\n`)&&detail.trimEnd().endsWith("}"),"Loaded job identity changed");
    requireThat(!references(detail,targets),"Recovery payload has loaded launch consumers");
  }
  for(const directory of [join(homedir(),"Library/LaunchAgents"),"/Library/LaunchAgents","/Library/LaunchDaemons"]) {
    if(absent(directory))continue;
    for(const name of readdirSync(directory).filter(name=>name.endsWith(".plist"))) {
      const path=join(directory,name),st=lstatSync(path);requireThat(st.isFile()&&!st.isSymbolicLink(),"Unsafe persisted launch consumer");
      let text:string;try{text=run("/usr/bin/plutil",["-convert","json","-o","-","--",path]);}
      catch {
        const parent=lstatSync(directory),outside=historicalDaemonOutsidePublicationScope({directory,regular:st.isFile(),canonical:realpathSync(path)===path&&realpathSync(directory)===directory,
          uid:st.uid,mode:st.mode,parentRootOwned:parent.uid===0&&!parent.isSymbolicLink()&&!(parent.mode&0o022),
          readable:canAccess(path,constants.R_OK),writable:canAccess(path,constants.W_OK),parentWritable:canAccess(directory,constants.W_OK)});
        requireThat(outside&&!references(path,targets)&&!/tweakers|codex[-+]plusplus|codex\+\+/i.test(path),"Unresolved unreadable launch definition");continue;
      }
      requireThat(!references(text,targets),"Recovery payload has persisted launch consumers");
    }
  }
  // Historical journals/receipts are provenance. Only current configuration and
  // enabled descriptors may keep an allocation alive. Do not scan account data.
  for(const relative of ["refresh-state.json","doctor/update.json","direct-official-update.json","variants/tweakers/config.json","variants/tweakers/state.json","variants/tweakers/transactions/variant-promotion/active.json"]) {
    const path=join(root,relative);if(!absent(path))requireThat(!references(safeText(path),targets),"Recovery payload has current configuration consumers");
  }
  const descriptors=join(root,"menu-bar-descriptors");if(!absent(descriptors))for(const name of readdirSync(descriptors).filter(name=>name.endsWith(".json")))requireThat(!references(safeText(join(descriptors,name)),targets),"Recovery payload has descriptor consumers");
  for(const target of targets.filter(path=>path.startsWith("/")&&!absent(path))) {
    // lsof status 1 with empty output and no diagnostic is the exact empty census.
    try {requireThat(!run("/usr/sbin/lsof",["-nP","-F","p",target]).trim(),"Recovery image has open consumers");}
    catch(error) {
      const result=error as {status?:number;stdout?:Buffer|string;stderr?:Buffer|string};
      requireThat(result.status===1&&!String(result.stdout??"").trim()&&!String(result.stderr??"").trim(),"Recovery open-file census unavailable or occupied");
    }
  }
}
const productionRecoveryHost:RecoveryHost={
  fileSnapshot:snapshot,fileIdentity:identity,allocationAbsent:absent,capacity:inspectLocalArtifactCapacity,
  space(manifest) {const free=statfsSync(manifest.old.archiveVolume);requireThat(BigInt(free.bavail)*BigInt(free.bsize)>=BigInt(manifest.old.originalSeal.bytes)*3n+1024n**3n,"Archive lacks restoration capacity");},
  async archive(manifest) {
    const path=manifest.old.archive,before=snapshot(path);requireThat(equal(before,manifest.archiveSnapshot),"Archive identity drift");
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const descriptor=()=>{const st=fstatSync(fd,{bigint:true});return Object.fromEntries(Object.keys(before).map(key=>[key,String(st[key as keyof typeof st])]));};
    try {
      requireThat(equal(descriptor(),before),"Archive descriptor changed");const digest=createHash("sha256");
      for await(const chunk of createReadStream(path,{fd,autoClose:false,start:0}))digest.update(chunk);
      requireThat(digest.digest("hex")===manifest.old.archiveSHA256&&equal(snapshot(path),before)&&equal(descriptor(),before),"Archive checksum drift");
      requireThat(equal(sealArchiveTree(path,basename(manifest.old.original)),manifest.old.originalSeal)&&equal(snapshot(path),before)&&equal(descriptor(),before),"Archive seal drift");
    }finally{closeSync(fd);}requireThat(equal(snapshot(path),before),"Archive changed after verification");
  },
  volume(volume,uuid) {const policy=readArtifactRetentionPolicy(join(homedir(),"Library/Application Support/Tweakers"));requireThat(policy.archiveVolume===volume&&policy.archiveVolumeUUID===uuid,"Pinned archive policy changed");assertArchiveVolume(volume,uuid);},
  async fallback(root) {const {verifyInstalledVariantFallback}=await import("./commands/create-variant.js");return verifyInstalledVariantFallback(root);},
  consumers:assertConsumers,
  imageMappings() {
    const parsed=plist.parse(run("/usr/bin/hdiutil",["info","-plist"])) as {images?:Array<{"image-path"?:string;"system-entities"?:Array<{"mount-point"?:string}>}>};
    requireThat(Array.isArray(parsed.images),"Image mapping census unavailable");
    return parsed.images.map(row=>{requireThat(typeof row["image-path"]==="string"&&Array.isArray(row["system-entities"]),"Malformed image mapping");return {image:row["image-path"],mounts:row["system-entities"].flatMap(entity=>entity["mount-point"]?[entity["mount-point"]]:[])};});
  },
  mountBoundary(mount) {
    requireThat(realpathSync(mount)===mount,"Recovery mount is noncanonical");
    const info=plist.parse(run("/usr/sbin/diskutil",["info","-plist",mount])) as Record<string,unknown>;
    requireThat(info.MountPoint===mount&&info.FilesystemType==="apfs"&&info.GlobalPermissionsEnabled===true,"Recovery mount is not owner-aware APFS");
    const lines=run("/sbin/mount",[]).split("\n").filter(line=>line.includes(` on ${mount} (`));
    requireThat(lines.length===1&&["noexec","nosuid"].every(flag=>new RegExp(`[,(] ${flag}[,)]`).test(lines[0]!))&&!/noowners/.test(lines[0]!),"Recovery mount lacks noexec/nosuid/owners");
  },
  createImage(path,size) {requireThat(absent(path),"Proof image already exists");run("/usr/bin/hdiutil",["create","-quiet","-size",size,"-type","SPARSE","-fs","APFS","-volname","TweakersArchiveVerify",path]);requireThat(lstatSync(path).isFile(),"Proof image creation failed");},
  attach(image,mount) {run("/usr/sbin/diskutil",["image","attach","--nobrowse","--mountOptions","noexec,nosuid,owners","--mountPoint",mount,image]);},
  extract(manifest) {
    // Validate every archive member before tar may write into the noexec image.
    // A matching seal alone does not reject an extra traversal member.
    run("/usr/bin/python3",["-c",String.raw`import sys,tarfile,posixpath
archive,app=sys.argv[1:]
with tarfile.open(archive,'r:') as source:
 for member in source:
  name=member.name.rstrip('/')
  if name.startswith('/') or '..' in name.split('/') or not (name==app or name.startswith(app+'/') or name=='._'+app): raise RuntimeError('Unsafe recovery archive member')
  if member.issym():
   target=posixpath.normpath(posixpath.join(posixpath.dirname(name),member.linkname))
   if member.linkname.startswith('/') or not (target==app or target.startswith(app+'/')): raise RuntimeError('Recovery link escapes proof root')
  if not (member.isdir() or member.isfile() or member.issym()): raise RuntimeError('Unsupported recovery archive member')
`,manifest.old.archive,basename(manifest.old.original)]);
    run("/usr/bin/tar",["--mac-metadata","--acls","--xattrs","-xpf",manifest.old.archive,"-C",manifest.allocation.mount]);
    const path=join(manifest.allocation.mount,basename(manifest.old.original));
    if(!equal(sealOfficialSourceTree(path),manifest.old.originalSeal))restoreSealedArchiveFileContents(manifest.old.archive,basename(manifest.old.original),path,manifest.old.originalSeal);
  },
  restored(manifest) {const path=join(manifest.allocation.mount,basename(manifest.old.original));return {identity:identity(path),seal:sealOfficialSourceTree(path),metadata:JSON.parse(restorationMetadata(path)),fingerprint:fingerprintVariantGeneration(path)};},
  detach(mount) {run("/usr/bin/hdiutil",["detach",mount]);},
  reserveAdmission:reserveCurrentSealedManagerRecoveryAdmission,
  async withLocks(root,work) {return withLocalOperation("missing artifact recovery",()=>withLifecycleLock(lifecycleLockFile(root),"missing artifact recovery",async()=>{
    const lock=acquireProcessLock(join(root,"variants/tweakers/transactions/variant-promotion.lock"));try{return await work();}finally{lock.release();}
  }),join(root,"local-operation"));},
};

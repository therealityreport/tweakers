import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { localOperationRoot, readLocalOperation, withLocalOperation, type LocalOperationRecord } from "./local-operation.js";
import { readDoctorPrivateJson, readDoctorUpdateJob, writeDoctorPrivateJson } from "./doctor-store.js";
import { readReservations, retireLocalArtifactAt } from "./local-artifacts.js";
import { readRegisteredOfficialSource } from "./official-source-registration.js";

export interface OperationRetentionResult { retained: string[]; eligible: string[]; retired: string[]; }

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
interface TreeIdentity {dev:number;ino:number;sha256:string;entries:number;bytes:string;}
export interface FailedOfficialSourceJournal {
  version:1; kind:"failed-official-source"; reservationId:string; sourcePath:string; workRoot:string;
  identity:TreeIdentity; sourceIdentity:{dev:number;ino:number}; operationId:string|null;
  phase:"failed"|"prepared"|"retired"|"reconciled";
}
export function failedOfficialSourceJournalPath(root:string,id:string):string {
  if (!UUID.test(id)) throw new Error("Invalid failed-source reservation ID");
  return join(root,"failed-official-sources",`${id}.json`);
}
/** Hash a failed extraction without following even malformed symlinks. */
function fingerprintTree(root:string):TreeIdentity {
  const base=lstatSync(root);
  if (!base.isDirectory() || base.isSymbolicLink() || realpathSync(root)!==resolve(root)) throw new Error("Failed source root is not a real canonical directory");
  const hash=createHash("sha256"), chunk=Buffer.allocUnsafe(1024*1024);
  let entries=0,bytes=0n;
  const visit=(path:string,name:string):void=>{
    const stat=lstatSync(path);
    entries++;
    hash.update(name).update("\0").update(String(stat.mode&0o7777)).update("\0");
    if(stat.isDirectory()&&!stat.isSymbolicLink()) {
      hash.update("dir\0");
      for(const child of readdirSync(path).sort())visit(join(path,child),name?`${name}/${child}`:child);
    } else if(stat.isSymbolicLink())hash.update("link\0").update(readlinkSync(path)).update("\0");
    else if(stat.isFile()) {
      hash.update("file\0").update(String(stat.size)).update("\0");bytes+=BigInt(stat.size);
      const fd=openSync(path,"r");
      try {for(;;){const count=readSync(fd,chunk,0,chunk.length,null);if(!count)break;hash.update(chunk.subarray(0,count));}}
      finally{closeSync(fd);}
    } else throw new Error(`Unsupported failed-source member: ${path}`);
  };
  visit(root,"");
  return {dev:base.dev,ino:base.ino,sha256:hash.digest("hex"),entries,bytes:bytes.toString()};
}
export function recordFailedOfficialSource(root:string,reservationId:string,sourcePath:string,workRoot:string):void {
  if (sourcePath!==join(workRoot,"extracted","ChatGPT.app") || resolve(workRoot)!==workRoot
    || realpathSync(workRoot)!==workRoot) throw new Error("Failed source location is not exact");
  const reservation=readReservations(root).find(item=>item.id===reservationId&&item.state!=="retired");
  if (!reservation || reservation.paths.length!==1 || reservation.paths[0]!==sourcePath) throw new Error("Failed source reservation changed");
  const stat=lstatSync(sourcePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Failed source app root is unsafe");
  const journal:FailedOfficialSourceJournal={version:1,kind:"failed-official-source",reservationId,sourcePath,workRoot,
    identity:fingerprintTree(workRoot),sourceIdentity:{dev:stat.dev,ino:stat.ino},operationId:reservation.operationId??null,phase:"failed"};
  writeDoctorPrivateJson(failedOfficialSourceJournalPath(root,reservationId),journal);
}
export function hasUnreconciledFailedSource(root:string,workRoot:string):boolean {
  const directory=join(root,"failed-official-sources");
  if(!existsSync(directory))return false;
  for(const name of readdirSync(directory)) {
    if(!UUID.test(name.replace(/\.json$/,"")) || !name.endsWith(".json"))continue;
    const record=readDoctorPrivateJson(join(directory,name)) as FailedOfficialSourceJournal;
    if(record?.workRoot && (record.workRoot===workRoot || record.workRoot.startsWith(workRoot+"/"))
      && record.phase!=="reconciled")return true;
  }
  return false;
}
export async function reconcileFailedOfficialSource(root:string,id:string,apply=false,
  trashRoot=join(homedir(),".Trash"),operationRoot=localOperationRoot()):Promise<{eligible:boolean;retired:boolean;reason:string}> {
  // The macOS /var alias must not turn an owner-private result into a
  // noncanonical Doctor read. Resolve the already-existing parent, while
  // refusing an operation directory that is itself a symlink.
  mkdirSync(operationRoot,{recursive:true,mode:0o700});
  if (lstatSync(operationRoot).isSymbolicLink())
    throw new Error("Failed-source operation root is a symlink");
  const canonicalOperationRoot=realpathSync(operationRoot);
  const prior=readLocalOperation(canonicalOperationRoot);
  return withLocalOperation("failed official source reconciliation",async()=>{
    const file=failedOfficialSourceJournalPath(root,id);
    const journal=readDoctorPrivateJson(file) as FailedOfficialSourceJournal|null;
    if(!journal || journal.version!==1 || journal.kind!=="failed-official-source" || journal.reservationId!==id
      || journal.sourcePath!==join(journal.workRoot,"extracted","ChatGPT.app")
      || !["failed","prepared","retired","reconciled"].includes(journal.phase))
      throw new Error("Failed-source journal is missing or requires recovery");
    if(journal.phase==="reconciled")return {eligible:false,retired:true,reason:"Already reconciled"};
    const reservation=readReservations(root).find(item=>item.id===id);
    if(!reservation || reservation.paths.length!==1 || reservation.paths[0]!==journal.sourcePath
      || reservation.transactionRef || reservation.operationId!==journal.operationId
      || (reservation.state==="retired" && journal.phase!=="retired"))
      throw new Error("Failed-source reservation is active or changed");
    if(journal.operationId && prior?.id===journal.operationId && prior.state==="running")
      throw new Error("Failed-source operation is still running");
    const terminal=journal.operationId
      ? readDoctorPrivateJson(join(canonicalOperationRoot,`result-${journal.operationId}.json`)) as LocalOperationRecord|null : null;
    if(journal.operationId && (terminal?.id!==journal.operationId || !["completed","failed"].includes(terminal.state)))
      throw new Error("Failed-source owner has no terminal result");
    const doctor=readDoctorUpdateJob(root);
    if(doctor && [doctor.sourcePath,doctor.candidatePackage,doctor.baselinePath].some(path=>typeof path==="string"&&path.startsWith(journal.workRoot)))
      throw new Error("Current Doctor job still references failed source");
    const registered=readRegisteredOfficialSource(root);
    if(registered.artifactPath?.startsWith(journal.workRoot))throw new Error("Registered official source still references failed source");
    const direct=readDoctorPrivateJson(join(root,"direct-official-update.json")) as {workRoot?:string;phase?:string}|null;
    if(direct?.workRoot && journal.workRoot.startsWith(direct.workRoot+"/") && direct.phase!=="preparing")
      throw new Error("Direct update transaction still references failed source");
    const destination=join(trashRoot,`Tweakers-failed-source-${id}`);
    const receipt=join(root,"artifact-archives","failed-official-sources",`${id}.json`);
    const evidence={version:1,kind:"failed-official-source-retirement",reservationId:id,original:journal.workRoot,destination,
      identity:journal.identity,reason:"Failed partial or invalid official-source extraction; no active reference",
      restoration:"Move the intact Trash directory back to the original path under lifecycle ownership",phase:"prepared"};
    const originExists=existsSync(journal.workRoot), destinationExists=existsSync(destination);
    if(originExists===destinationExists)throw new Error("Failed-source retirement has ambiguous original and Trash paths");
    const observed=fingerprintTree(originExists?journal.workRoot:destination);
    if(JSON.stringify(observed)!==JSON.stringify(journal.identity))throw new Error("Failed-source bytes or identity changed");
    if(originExists) {
      const source=lstatSync(journal.sourcePath);
      if(source.isSymbolicLink() || source.dev!==journal.sourceIdentity.dev || source.ino!==journal.sourceIdentity.ino)
        throw new Error("Failed-source app identity changed");
    }
    if(!apply)return {eligible:true,retired:destinationExists,reason:destinationExists?"Journaled Trash move awaits reservation reconciliation":"Unreferenced failed preparation with terminal owner"};
    if(!existsSync(trashRoot) || realpathSync(trashRoot)!==resolve(trashRoot) || !lstatSync(trashRoot).isDirectory())
      throw new Error("Recoverable Trash is unavailable");
    if(journal.phase==="failed") {
      if(destinationExists)throw new Error("Failed-source Trash destination has no prepared receipt");
      writeDoctorPrivateJson(receipt,evidence);
      writeDoctorPrivateJson(file,{...journal,phase:"prepared"});
    } else {
      const saved=readDoctorPrivateJson(receipt) as typeof evidence|null;
      if(!saved || saved.version!==1 || saved.kind!==evidence.kind || saved.reservationId!==id
        || saved.original!==evidence.original || saved.destination!==destination
        || JSON.stringify(saved.identity)!==JSON.stringify(journal.identity))
        throw new Error("Failed-source retirement receipt changed");
    }
    if(originExists) {
      if(JSON.stringify(fingerprintTree(journal.workRoot))!==JSON.stringify(journal.identity))throw new Error("Failed-source content changed before retirement");
      renameSync(journal.workRoot,destination);
    }
    writeDoctorPrivateJson(receipt,{...evidence,phase:"retired"});
    writeDoctorPrivateJson(file,{...journal,phase:"retired"});
    if(reservation.state!=="retired")retireLocalArtifactAt(root,journal.sourcePath,receipt);
    writeDoctorPrivateJson(file,{...journal,phase:"reconciled"});
    return {eligible:true,retired:true,reason:"Moved failed preparation to recoverable Trash"};
  },canonicalOperationRoot);
}

/** Keep the newest 100 terminal results and every record with recovery context. */
export async function maintainTerminalOperationResults(
  root: string, apply = false, trashRoot = join(homedir(), ".Trash"),
): Promise<OperationRetentionResult> {
  if (realpathSync(root) !== resolve(root)) throw new Error("Operation retention root must be canonical");
  // withLocalOperation publishes its own current operation. Preserve the
  // immediately preceding result even if its timestamp is outside the window.
  const priorOperationId = readLocalOperation(root)?.id;
  return withLocalOperation("terminal operation retention", async () => {
    const current = readLocalOperation(root);
    const failedSourceOwners=new Set<string>();
    for(const reservation of readReservations(dirname(root))) {
      // An unresolved generation's exact terminal owner is recovery input.
      // A typed missing-recovery manifest keeps that input pinned after
      // retirement, even when its result has no transactionRef of its own.
      if((reservation.state!=="retired"||reservation.missingRecovery)&&reservation.operationId)failedSourceOwners.add(reservation.operationId);
    }
    const failedDirectory=join(dirname(root),"failed-official-sources");
    if(existsSync(failedDirectory))for(const name of readdirSync(failedDirectory)) {
      if(!name.endsWith(".json"))continue;
      const journal=readDoctorPrivateJson(join(failedDirectory,name)) as FailedOfficialSourceJournal|null;
      if(!journal || journal.kind!=="failed-official-source")throw new Error("Failed-source retention reference is invalid");
      if(journal.phase!=="reconciled"&&journal.operationId)failedSourceOwners.add(journal.operationId);
    }
    const records: Array<{path:string; record:LocalOperationRecord; time:number; identity:{dev:number;ino:number;size:number}}> = [];
    for (const name of readdirSync(root)) {
      if (!/^result-[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(root,name), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
        || (stat.mode & 0o077) !== 0 || stat.size > 1024*1024) throw new Error(`Unsafe operation result: ${path}`);
      const record = JSON.parse(readFileSync(path,"utf8")) as LocalOperationRecord;
      if (record.version !== 1 || `result-${record.id}.json` !== name || !["completed","failed"].includes(record.state)
        || !Number.isFinite(Date.parse(record.startedAt))) throw new Error(`Invalid terminal operation result: ${path}`);
      records.push({path,record,time:Date.parse(record.startedAt),identity:{dev:stat.dev,ino:stat.ino,size:stat.size}});
    }
    records.sort((a,b)=>b.time-a.time || b.path.localeCompare(a.path));
    const retained: string[] = [], eligible: string[] = [], retired: string[] = [];
    for (const [index, item] of records.entries()) {
      const referenced = item.record.id === current?.id || item.record.id === priorOperationId || failedSourceOwners.has(item.record.id)
        || !!item.record.transactionRef || !!item.record.children?.length
        || item.record.phase === "recovery-required";
      if (index < 100 || referenced) { retained.push(item.path); continue; }
      eligible.push(item.path);
    }
    if (apply && eligible.length) {
      if (!existsSync(trashRoot) || realpathSync(trashRoot) !== resolve(trashRoot)
        || !lstatSync(trashRoot).isDirectory()) throw new Error("Recoverable Trash is unavailable");
      // Receipts persist across runs. Reuse only an exact private directory,
      // and prepare it before creating any Trash destination.
      const receipts = join(root,"retirement-receipts");
      try { mkdirSync(receipts,{mode:0o700}); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const receiptsStat = lstatSync(receipts);
      if (!receiptsStat.isDirectory() || receiptsStat.isSymbolicLink() || receiptsStat.uid !== process.getuid?.()
        || (receiptsStat.mode & 0o077) !== 0) throw new Error(`Unsafe retirement receipt directory: ${receipts}`);
      const destination = join(trashRoot, `Tweakers-terminal-operations-${randomUUID()}`);
      mkdirSync(destination,{mode:0o700});
      for (const path of eligible) {
        // The lifecycle owner remains held. Revalidate the exact record before
        // each move; a changed result is left in place for investigation.
        const prior = records.find(item=>item.path===path)!;
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
          || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0
          || stat.dev !== prior.identity.dev || stat.ino !== prior.identity.ino || stat.size !== prior.identity.size) throw new Error(`Operation result changed: ${path}`);
        const fresh = JSON.parse(readFileSync(path,"utf8")) as LocalOperationRecord;
        if (JSON.stringify(fresh) !== JSON.stringify(prior.record)) throw new Error(`Operation result changed: ${path}`);
        const target = join(destination,path.slice(root.length+1));
        const receipt = join(receipts,`${prior.record.id}.json`);
        const evidence = {version:1,kind:"terminal-operation-retirement",original:path,destination:target,
          identity:prior.identity,reason:"Older than newest 100 terminal results; no recovery reference",
          restoration:"Move the intact result file from recoverable Trash to its original path under lifecycle ownership",
          phase:"prepared"};
        writeDoctorPrivateJson(receipt,evidence);
        const final = lstatSync(path);
        if (final.dev !== prior.identity.dev || final.ino !== prior.identity.ino || final.size !== prior.identity.size)
          throw new Error(`Operation result changed before retirement: ${path}`);
        renameSync(path,target);
        writeDoctorPrivateJson(receipt,{...evidence,phase:"retired"});
        retired.push(path);
      }
    }
    return {retained,eligible,retired};
  }, root);
}

import { isDoctorSuppliedNativeSourcePolicyV1, readDoctorUpdateJob, writeDoctorPrivateJson, type DoctorUpdateJobV1, type DoctorSuppliedNativeSourcePolicyV1 } from "./doctor-store.js";
import { fingerprintAppContents } from "./environment-profile.js";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import plist from "plist";
import { targetUserHome } from "./ownership.js";
import { acquireProcessLock, readLockOwner } from "./process-lock.js";
import { withLocalOperation } from "./local-operation.js";
import { inspectLocalArtifactCapacity, assertLocalArtifactSlot, publishLocalArtifactSnapshot, retireLocalArtifactAt } from "./local-artifacts.js";
import { canonicalTweakersManagerRoot } from "./manager-descriptor.js";
import { readRegisteredOfficialSource, officialSourcePaths, sealOfficialSourceTree } from "./official-source-registration.js";
import { assertSurvivingArchiveMembers, restoreSealedArchiveFileContents, sealArchiveTree, readDoctorBaseline } from "./doctor-baseline.js";

const ARCHIVE_VOLUME="/Volumes/SHOWS DB";
const ARCHIVE_UUID="F0805FA8-8B04-3326-A9A3-EA36B48EFD17";
export function readArtifactRetentionPolicy(root: string): { retireTo: "trash" | "archive"; archiveVolume: string; archiveVolumeUUID: string | null; allowTrashFallback: boolean } {
  const file = join(root, "artifact-retention.json");
  const defaults = { retireTo: "trash" as const, archiveVolume: ARCHIVE_VOLUME, archiveVolumeUUID: ARCHIVE_UUID, allowTrashFallback: true };
  if (!existsSync(file)) return defaults;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.size > 16384) throw new Error("Unsafe artifact retention settings");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid artifact retention settings");
  const value = { ...defaults, ...saved };
  if ((value.retireTo !== "trash" && value.retireTo !== "archive")
    || typeof value.archiveVolume !== "string" || !/^\/Volumes\/[^/]+$/.test(value.archiveVolume)
    || (value.archiveVolumeUUID != null && typeof value.archiveVolumeUUID !== "string")
    || typeof value.allowTrashFallback !== "boolean") throw new Error("Invalid artifact retention settings");
  return { retireTo: value.retireTo, archiveVolume: value.archiveVolume, archiveVolumeUUID: value.archiveVolumeUUID ?? null, allowTrashFallback: value.allowTrashFallback };
}
const run=(command:string,args:string[])=>{
  const env={...process.env};
  if(command==="/usr/bin/tar")delete env.COPYFILE_DISABLE;
  return execFileSync(command,args,{env,encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:120_000,maxBuffer:1024*1024});
};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
async function checksum(path:string):Promise<string>{const h=createHash("sha256");for await(const chunk of createReadStream(path))h.update(chunk);return h.digest("hex");}
export function assertArchiveVolume(volume = ARCHIVE_VOLUME, uuid: string | null = ARCHIVE_UUID):void {
  const info=plist.parse(run("/usr/sbin/diskutil",["info","-plist",volume])) as Record<string,unknown>;
  if((uuid !== null && info.VolumeUUID!==uuid)||info.MountPoint!==volume||info.Writable!==true)throw new Error("Configured archive volume is unavailable or read-only");
}
/** Compare semantic macOS metadata; compression is a storage representation. */
export function restorationMetadata(root:string):string {
  return execFileSync("/usr/bin/python3",["-c",String.raw`
import os,sys,json,hashlib,ctypes,stat
lib=ctypes.CDLL(None,use_errno=True)
lib.acl_get_link_np.restype=ctypes.c_void_p
lib.acl_to_text.restype=ctypes.c_void_p
lib.acl_to_text.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
lib.acl_free.argtypes=[ctypes.c_void_p]
result={}
for base,dirs,files in os.walk(sys.argv[1],followlinks=False):
 for name in ['.']+dirs+files:
  p=base if name=='.' else os.path.join(base,name)
  key=os.path.relpath(p,sys.argv[1]);b=os.fsencode(p);s=os.lstat(p)
  n=lib.listxattr(b,None,0,1)
  if n<0: raise OSError(ctypes.get_errno(),p)
  buf=ctypes.create_string_buffer(n)
  if lib.listxattr(b,buf,n,1)!=n:raise RuntimeError("Metadata inventory changed")
  attrs={}
  for attr in buf.raw.split(b'\0'):
   if not attr or attr in (b'com.apple.macl',b'com.apple.provenance',b'com.apple.decmpfs'):continue
   size=lib.getxattr(b,attr,None,0,0,1)
   if size<0:raise OSError(ctypes.get_errno(),p)
   value=ctypes.create_string_buffer(size)
   if lib.getxattr(b,attr,value,size,0,1)!=size:raise RuntimeError('Metadata changed')
   attrs[os.fsdecode(attr)]=hashlib.sha256(value.raw).hexdigest()
  ctypes.set_errno(0);acl=lib.acl_get_link_np(b,0x100);text=None
  if not acl and ctypes.get_errno()!=2:raise OSError(ctypes.get_errno(),"Cannot read ACL: "+p)
  if acl:
   try:
    ptr=lib.acl_to_text(acl,None)
    if not ptr:raise OSError(ctypes.get_errno(),"Cannot serialize ACL: "+p)
    try:text=ctypes.string_at(ptr).decode()
    finally:lib.acl_free(ptr)
   finally:lib.acl_free(acl)
  result[key]={'xattrs':attrs,'acl':text,'flags':s.st_flags & ~0x20}
print(json.dumps(result,sort_keys=True,separators=(',',':')))
`,root],{encoding:"utf8",timeout:120_000,maxBuffer:32*1024*1024}).trim();
}
function assertNotExecuting(path:string):void {
  const commands=run("/bin/ps",["-axo","command="]).split("\n");
  if(commands.some(command=>command.includes(path+"/")))throw new Error("The rollback is still referenced by a running process");
}

/** The private current job supplies authority; caller-provided policy cannot waive ordering. */
export function assertDoctorNativeDownloadRetirementJob(job: DoctorUpdateJobV1 | null, jobId: string, requestedBuild: string,
  native: { nativeIdentity: string | null; nativeVersion: string | null; nativeBuild: string | null }, frontendFingerprint: string): DoctorSuppliedNativeSourcePolicyV1 {
  const policy = job?.suppliedNativeSourcePolicy;
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(jobId) || !job || job.schemaVersion !== 1 || job.id !== jobId
    || job.workflowVersion !== 2 || job.result.state !== "checking" || job.supersededBy || job.sourceOrigin !== "native"
    || !isDoctorSuppliedNativeSourcePolicyV1(policy) || job.nativeIdentity !== policy.nativeIdentity
    || requestedBuild !== policy.nativeBuild || native.nativeIdentity !== policy.nativeIdentity
    || native.nativeVersion !== policy.nativeVersion || native.nativeBuild !== policy.nativeBuild
    || frontendFingerprint !== policy.sourceAppFingerprint) throw new Error("Supplied native download retirement job is missing, changed or unverified");
  return { ...policy };
}

export function doctorDownloadSourceIsSuperseded(source: { build: string | null; version: string | null }, requestedBuild: string,
  suppliedNative?: { job: DoctorUpdateJobV1 | null; jobId: string; native: { nativeIdentity: string | null; nativeVersion: string | null; nativeBuild: string | null }; frontendFingerprint: string }): boolean {
  if (!/^[0-9]+$/.test(requestedBuild)) throw new Error("Invalid replacement source build");
  if (suppliedNative) {
    const policy = assertDoctorNativeDownloadRetirementJob(suppliedNative.job, suppliedNative.jobId, requestedBuild, suppliedNative.native, suppliedNative.frontendFingerprint);
    return !!source.build && /^[0-9]+$/.test(source.build) && !!source.version
      && (source.build !== policy.nativeBuild || source.version !== policy.nativeVersion);
  }
  return !!source.build && /^[0-9]+$/.test(source.build) && BigInt(source.build) < BigInt(requestedBuild);
}
/** Superseded downloads are disposable; signed reduced evidence remains local.
 * This never retires an installed app, rollback, candidate, or native desktop.
 */
export async function retireSupersededDoctorSource(root: string, installed: string, requestedBuild: string, options?: { suppliedNativeJobId: string }): Promise<void> {
  if (root !== canonicalTweakersManagerRoot() || installed !== "/Applications/Tweakers.app") return;
  if (!/^[0-9]+$/.test(requestedBuild)) throw new Error("Invalid replacement source build");
  await withLocalOperation("retire superseded downloaded source", async () => {
    const paths = officialSourcePaths(root);
    const lock = acquireProcessLock(paths.lockFile);
    try {
      const readNativeSelection = async () => {
        if (!options) return undefined;
        const { readDoctorIndependentInputs, DOCTOR_NATIVE_APP } = await import("./doctor-independent.js");
        const selection = { job: readDoctorUpdateJob(root), jobId: options.suppliedNativeJobId,
          native: readDoctorIndependentInputs(root), frontendFingerprint: fingerprintAppContents(DOCTOR_NATIVE_APP) };
        const policy = assertDoctorNativeDownloadRetirementJob(selection.job, selection.jobId, requestedBuild, selection.native, selection.frontendFingerprint);
        return { selection, policy };
      };
      const nativeAuthority = await readNativeSelection();
      const receipts = join(root, "artifact-archives/superseded-downloads");
      const trash = join(targetUserHome(), ".Trash");
      const finish = (receiptPath: string, record: {original: string; destination: string; seal: ReturnType<typeof sealOfficialSourceTree>; retired: boolean; reservationReconciled: boolean}) => {
        if (existsSync(record.original) || !existsSync(record.destination)
          || !same(sealOfficialSourceTree(record.destination), record.seal)) throw new Error("Superseded download retirement needs reconciliation");
        record.retired = true;
        writeDoctorPrivateJson(receiptPath, record);
        retireLocalArtifactAt(root, record.original, receiptPath);
        record.reservationReconciled = true;
        writeDoctorPrivateJson(receiptPath, record);
      };
      // A crash after the atomic Trash move must not leave a phantom reservation.
      if (existsSync(receipts)) for (const name of readdirSync(receipts).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        const path = join(receipts, name), record = JSON.parse(readFileSync(path, "utf8"));
        const id = name.slice(0, -5);
        if (record.version !== 1 || record.kind !== "superseded-doctor-download"
          || typeof record.original !== "string" || !isDownloadedSource(root, record.original)
          || record.destination !== join(trash, `Tweakers-source-${id}`, "ChatGPT.app")) throw new Error("Invalid superseded source retirement receipt");
        if (record.reservationReconciled === true) continue;
        if (existsSync(record.original) && !existsSync(record.destination)) continue;
        finish(path, record);
      }
      const capacity = inspectLocalArtifactCapacity(root, installed);
      if (capacity.occupied < 2) return;
      const source = readRegisteredOfficialSource(root);
      if (source.state !== "ready" || source.constructionState !== "available" || !source.artifactPath || !source.baselinePath
        || !source.build || !doctorDownloadSourceIsSuperseded({ build: source.build, version: source.version ?? null }, requestedBuild, nativeAuthority?.selection)
        || !isDownloadedSource(root, source.artifactPath) || capacity.blockers.length || capacity.occupied !== 2
        || !capacity.paths.includes(installed) || !capacity.paths.includes(source.artifactPath)) return;
      const baseline = readDoctorBaseline(source.baselinePath);
      if (baseline.originalAppPath !== source.artifactPath || baseline.generationId !== source.generationId) throw new Error("Superseded source baseline does not match");
      const { verifyInstalledVariantFallback } = await import("./commands/create-variant.js");
      const fallback = verifyInstalledVariantFallback(root), seal = sealOfficialSourceTree(source.artifactPath);
      if (!same(seal, (baseline.sourceReceipt as {artifact: {treeSeal: unknown}}).artifact.treeSeal)) throw new Error("Superseded source bytes changed");
      assertNotExecuting(source.artifactPath);
      if (realpathSync(trash) !== trash || !lstatSync(trash).isDirectory()) throw new Error("User Trash is unavailable");
      const id = randomUUID(), destination = join(trash, `Tweakers-source-${id}`, "ChatGPT.app");
      mkdirSync(dirname(destination), {mode: 0o700});
      mkdirSync(receipts, {recursive: true, mode: 0o700});
      const receipt = join(receipts, `${id}.json`);
      const record = {version: 1, kind: "superseded-doctor-download", original: source.artifactPath, destination,
        previousBuild: source.build, requestedBuild, baselinePath: source.baselinePath, baselineFingerprint: baseline.fingerprint,
        fallback, seal, retired: false, reservationReconciled: false, reason: nativeAuthority
          ? "Disposable download excluded by verified supplied native job; signed source evidence retained"
          : "Superseded disposable download; signed source evidence retained",
        ...(nativeAuthority ? { suppliedNativeJobId: options!.suppliedNativeJobId, suppliedNativeSourcePolicy: nativeAuthority.policy } : {}) };
      writeDoctorPrivateJson(receipt, record);
      const finalNativeAuthority = await readNativeSelection();
      if (!same(finalNativeAuthority?.policy, nativeAuthority?.policy)) throw new Error("Supplied native policy changed before download retirement");
      if (!same(verifyInstalledVariantFallback(root), fallback) || !same(readRegisteredOfficialSource(root), source)
        || !same(sealOfficialSourceTree(source.artifactPath), seal)) throw new Error("Source or working installation changed before retirement");
      assertNotExecuting(source.artifactPath);
      renameSync(source.artifactPath, destination);
      finish(receipt, record);
      publishLocalArtifactSnapshot(root, inspectLocalArtifactCapacity(root, installed));
    } finally { lock.release(); }
  });
}
function isDownloadedSource(root: string, path: string): boolean {
  const jobs = join(root, "doctor/jobs") + "/";
  return path.startsWith(jobs) && /^[a-f0-9-]{36}\/upstream\/extracted\/ChatGPT\.app$/.test(path.slice(jobs.length))
    && (!existsSync(path) || !lstatSync(path).isSymbolicLink() && realpathSync(path) === path);
}

/** Retire only the exact previous app of a verified committed installation. */
export async function prepareLocalArtifactSlot(root:string,installed:string):Promise<void> {
  if(inspectLocalArtifactCapacity(root,installed).occupied<2){assertLocalArtifactSlot(root,installed);return;}
  if(root!==canonicalTweakersManagerRoot()||installed!=="/Applications/Tweakers.app"){assertLocalArtifactSlot(root,installed);return;}
  await withLocalOperation("retire verified rollback for candidate",async()=>{
    const {verifyInstalledVariantFallback}=await import("./commands/create-variant.js");
    const variant=join(root,"variants/tweakers"),lockPath=join(variant,"transactions/variant-promotion.lock");
    const ownedHere=readLockOwner(lockPath)===process.pid;
    const lock=ownedHere?null:acquireProcessLock(lockPath);
    try {
      const active=JSON.parse(readFileSync(join(variant,"transactions/variant-promotion/active.json"),"utf8"));
      if(typeof active.id!=="string"||!/^[a-f0-9-]{36}$/.test(active.id))throw new Error("Installed generation identity is unavailable");
      const rollback=join(variant,"previous",active.id,"app/Tweakers.app");
      await reconcileVerifiedRollbackRetirements(root);
      const capacity=inspectLocalArtifactCapacity(root,installed);
      if (capacity.occupied < 2) { assertLocalArtifactSlot(root, installed); return; }
      if(capacity.blockers.length||capacity.occupied!==2||!capacity.paths.includes(installed)||!capacity.paths.includes(rollback))throw new Error(`Artifact cleanup is required before staging (${capacity.occupied}/2); no capacity exception was granted`);
      const fallback=verifyInstalledVariantFallback(root);
      const journal=JSON.parse(readFileSync(join(variant,"transactions/variant-promotion",active.id+".json"),"utf8"));
      const previous=journal.entries?.find((entry:{name:string})=>entry.name==="app");
      if(journal.phase!=="committed"||previous?.archive!==rollback||!previous.previous)throw new Error("Rollback provenance is not a committed generation");
      const {fingerprintVariantGeneration}=await import("./commands/create-variant.js");
      if(!same(fingerprintVariantGeneration(rollback),previous.previous))throw new Error("Rollback bytes changed; retirement refused");
      assertNotExecuting(rollback);
      const policy = readArtifactRetentionPolicy(root);
      let trashReason: string | null = policy.retireTo === "trash" ? "Trash retention policy; verified fallback retained" : null;
      if (policy.retireTo === "archive") {
        try { assertArchiveVolume(policy.archiveVolume, policy.archiveVolumeUUID); }
        catch (error) {
          if (!policy.allowTrashFallback) throw error;
          trashReason = "Archive unavailable; verified fallback retained";
        }
      }
      if (trashReason !== null) {
        const trash = join(targetUserHome(), ".Trash");
        if (!existsSync(trash) || realpathSync(trash) !== trash || !lstatSync(trash).isDirectory()) throw new Error("Recoverable Trash is unavailable; rollback retained");
        const id = randomUUID(), destination = join(trash, `Tweakers-rollback-${id}`);
        const originalSeal = sealOfficialSourceTree(rollback);
        const stat = lstatSync(rollback);
        const receipt = join(root, "artifact-archives", "trash-retirement", `${id}.json`);
        mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 });
        const record = { version: 1, id, original: rollback, destination, originalSeal, originalIdentity: { dev: stat.dev, ino: stat.ino }, fallback, phase: "prepared", reason: trashReason, restoration: "Move the intact Trash directory back to original only under lifecycle ownership" };
        writeDoctorPrivateJson(receipt, record);
        assertNotExecuting(rollback);
        const fresh = lstatSync(rollback);
        if (fresh.dev !== stat.dev || fresh.ino !== stat.ino || !same(verifyInstalledVariantFallback(root), fallback) || !same(sealOfficialSourceTree(rollback), originalSeal)) throw new Error("Rollback or fallback changed before Trash retirement");
        renameSync(rollback, destination);
        record.phase = "retired"; writeDoctorPrivateJson(receipt, record);
        retireLocalArtifactAt(root, rollback, receipt);
        record.phase = "reconciled"; writeDoctorPrivateJson(receipt, record);
        publishLocalArtifactSnapshot(root, inspectLocalArtifactCapacity(root, installed));
        assertLocalArtifactSlot(root, installed);
        return;
      }
      const originalSeal=sealOfficialSourceTree(rollback);
      const originalMetadata=restorationMetadata(rollback);
      const originalStat=lstatSync(rollback),originalIdentity={dev:originalStat.dev,ino:originalStat.ino};
      const free=statfsSync(policy.archiveVolume);
      if(Number(free.bavail)*Number(free.bsize)<Number(originalSeal.bytes)*3+1024**3)throw new Error("Archive storage lacks restoration capacity");
      const archiveRoot=join(policy.archiveVolume,"_Mac-Archive/Tweakers/retired-rollbacks");mkdirSync(archiveRoot,{recursive:true});
      const id=randomUUID(),archive=join(archiveRoot,`${active.id}-${id}.tar`);
      const image=join(archiveRoot,`${id}.restore.sparseimage`),mount=join("/Volumes",`TweakersArchiveVerify-${id}`);
      const receiptRoot=join(root,"artifact-archives/rollback-retirement");mkdirSync(receiptRoot,{recursive:true,mode:0o700});
      const receiptPath=join(receiptRoot,`${id}.json`);
      const record={version:1,metadataVersion:1,originalMetadata:JSON.parse(originalMetadata),phase:"archiving",original:rollback,archive,archiveSHA256:null as string|null,volumeUUID:policy.archiveVolumeUUID,archiveVolume:policy.archiveVolume,originalSeal,originalIdentity,fallback,restorationVerified:false,retired:false,reservationReconciled:false};
      const publish=()=>writeDoctorPrivateJson(receiptPath,record);
      publish();let mounted=false,attachmentUncertain=false;
      try {
        run("/usr/bin/tar",["--format","pax","--mac-metadata","--acls","--xattrs","--no-read-sparse","-cpf",archive,"-C",dirname(rollback),basename(rollback)]);
        record.archiveSHA256=await checksum(archive);
        if(!same(sealArchiveTree(archive,basename(rollback)),originalSeal))throw new Error("Rollback archive did not reproduce the original tree seal");
        // Restoration stays on archive storage. It never creates a third local
        // desktop, and nothing is launched from the mounted verification image.
        run("/usr/bin/hdiutil",["create","-quiet","-size",`${Math.ceil(Number(originalSeal.bytes)/1024**3)+2}g`,"-type","SPARSE","-fs","APFS","-volname","TweakersArchiveVerify",image]);
        attachmentUncertain=true;
        run("/usr/sbin/diskutil",["image","attach","--nobrowse","--mountOptions","noexec,nosuid,owners","--mountPoint",mount,image]);mounted=true;attachmentUncertain=false;
        if(!run("/sbin/mount",[]).split("\n").some(line=>line.includes(` on ${realpathSync(mount)} (`)&&/[,(] noexec[,)]/.test(line)))throw new Error("Rollback restoration filesystem is not proven non-executable");
        run("/usr/bin/tar",["--mac-metadata","--acls","--xattrs","-xpf",archive,"-C",mount]);
        if(!same(sealOfficialSourceTree(join(mount,basename(rollback))),originalSeal))restoreSealedArchiveFileContents(archive,basename(rollback),join(mount,basename(rollback)),originalSeal);
        if(!same(sealOfficialSourceTree(join(mount,basename(rollback))),originalSeal))throw new Error("Rollback restoration verification failed; local rollback remains intact");
        if(restorationMetadata(join(mount,basename(rollback)))!==originalMetadata)throw new Error("Required macOS restoration metadata differs; local rollback remains intact");
        record.restorationVerified=true;record.phase="verified";publish();
        run("/usr/bin/hdiutil",["detach",mount]);mounted=false;rmSync(image,{force:true});rmSync(mount,{recursive:true,force:true});
        assertArchiveVolume(policy.archiveVolume, policy.archiveVolumeUUID);assertNotExecuting(rollback);
        if(!same(verifyInstalledVariantFallback(root),fallback)||!same(sealOfficialSourceTree(rollback),originalSeal)||restorationMetadata(rollback)!==originalMetadata)throw new Error("Fallback or rollback changed before retirement");
        if(realpathSync(rollback)!==rollback)throw new Error("Rollback path changed before retirement");
        if (await checksum(archive) !== record.archiveSHA256) throw new Error("Archive changed before retirement");
        record.phase="retiring";publish();
        rmSync(rollback,{recursive:true});record.retired=true;record.phase="retired";publish();retireLocalArtifactAt(root,rollback,receiptPath);record.reservationReconciled=true;publish();
        publishLocalArtifactSnapshot(root,inspectLocalArtifactCapacity(root,installed));
        assertLocalArtifactSlot(root,installed);
      }finally{
        if(mounted){try{run("/usr/bin/hdiutil",["detach",mount]);mounted=false;}catch{ /* Keep restoration evidence for explicit recovery. */ }}
        if(!mounted&&!attachmentUncertain){rmSync(image,{force:true});rmSync(mount,{recursive:true,force:true});}
      }
    }finally{lock?.release();}
  });
}

/** Resume only a proven deletion boundary, never infer success from a dead PID. */
export async function reconcileVerifiedRollbackRetirements(root: string): Promise<void> {
  const trashReceipts = join(root, "artifact-archives/trash-retirement");
  if (existsSync(trashReceipts)) {
    const { verifyInstalledVariantFallback } = await import("./commands/create-variant.js");
    for (const name of readdirSync(trashReceipts).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const receipt = join(trashReceipts, name);
      const record = JSON.parse(readFileSync(receipt, "utf8"));
      if (record.phase === "reconciled") continue;
      if (record.version !== 1 || record.id !== name.slice(0, -5)
        || record.destination !== join(targetUserHome(), ".Trash", `Tweakers-rollback-${record.id}`)
        || record.original !== join(root, "variants/tweakers/previous", record.fallback?.id ?? "", "app/Tweakers.app")) throw new Error("Invalid Trash retirement receipt");
      if (existsSync(record.original) && !existsSync(record.destination) && record.phase === "prepared") continue;
      if (existsSync(record.original) || !existsSync(record.destination)
        || !same(sealOfficialSourceTree(record.destination), record.originalSeal)
        || !same(verifyInstalledVariantFallback(root), record.fallback)) throw new Error("Trash retirement requires recovery; preserved payload changed");
      retireLocalArtifactAt(root, record.original, receipt);
      writeDoctorPrivateJson(receipt, { ...record, phase: "reconciled" });
    }
  }
  const receiptRoot = join(root, "artifact-archives/rollback-retirement");
  if (!existsSync(receiptRoot)) return;
  const { verifyInstalledVariantFallback } = await import("./commands/create-variant.js");
  for (const name of readdirSync(receiptRoot).filter(name => name.endsWith(".json"))) {
    const path = join(receiptRoot, name);
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (record.version !== 1 || record.reservationReconciled === true || !["retiring", "retired"].includes(record.phase)) continue;
    const expected = join(root, "variants/tweakers/previous", record.fallback?.id ?? "", "app/Tweakers.app");
    if (record.metadataVersion !== 1 || !record.originalMetadata || record.original !== expected || record.restorationVerified !== true
      || typeof record.archive !== "string" || !record.archive.startsWith(join(record.archiveVolume ?? ARCHIVE_VOLUME, "_Mac-Archive/Tweakers/retired-rollbacks") + "/")
      || !/^[a-f0-9]{64}$/.test(record.archiveSHA256)) throw new Error("Invalid rollback retirement recovery evidence");
    assertArchiveVolume(record.archiveVolume ?? ARCHIVE_VOLUME, record.volumeUUID === null ? null : record.volumeUUID ?? ARCHIVE_UUID);
    if (await checksum(record.archive) !== record.archiveSHA256
      || !same(sealArchiveTree(record.archive, "Tweakers.app"), record.originalSeal)
      || !same(verifyInstalledVariantFallback(root), record.fallback)) throw new Error("Rollback retirement recovery evidence changed");
    if (existsSync(record.original)) {
      const stat = lstatSync(record.original);
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(record.original) !== record.original
        || stat.dev !== record.originalIdentity?.dev || stat.ino !== record.originalIdentity?.ino) throw new Error("Partially retired rollback identity changed");
      assertNotExecuting(record.original);
      assertSurvivingArchiveMembers(record.archive, "Tweakers.app", record.original);
      const remaining=JSON.parse(restorationMetadata(record.original));
      for(const [member,metadata] of Object.entries(remaining))if(!same(metadata,record.originalMetadata[member]))throw new Error("Surviving rollback metadata changed: "+member);
      rmSync(record.original, { recursive: true });
    }
    record.phase = "retired"; record.retired = true;
    writeDoctorPrivateJson(path, record);
    retireLocalArtifactAt(root, record.original, path);
    record.reservationReconciled = true;
    writeDoctorPrivateJson(path, record);
  }
}

import { findExistingPreparedSigningIdentity, signCandidateReceiptResourceBundle, verifyCandidateReceiptResourceBundle } from "./codesign.js";
import { writePlist } from "./plist.js";
import { createHash, randomUUID } from "node:crypto";
import { constants, lchownSync, fchownSync, fchmodSync, fstatSync, ftruncateSync, fsyncSync, writeSync, closeSync, openSync, readSync, copyFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Header, Pax, list as listTar } from "tar";
import { assertLocalExecutionPath } from "./local-artifacts.js";
import type { DoctorSourceFileEvidence } from "./doctor-evidence.js";
import { writeDoctorPrivateJson } from "./doctor-store.js";
import { withLocalOperation } from "./local-operation.js";

interface ArchiveMember {offset?:number;type:number;mode:number;uid?:number;gid?:number;fullMode?:number;size?:number;sha256?:string;link?:string}
export interface BaselineFile { path: string; sha256?: string; link?: string; mode: number; }
export interface DoctorBaselineV1 {
  version: 1; kind: "tweakers-doctor-baseline"; generationId: string;
  originalAppPath: string; sourceReceiptSha256: string; sourceReceipt: unknown;
  archiveSha256: string | null; signingIdentityHash: string;
  storageLayoutVersion?: 2;
  trust: "captured-vendor-signature";
  files: BaselineFile[]; originalFiles: DoctorSourceFileEvidence[]; fingerprint: string;
}
interface BaselineSignature { sign(path:string,pin:string):void; verify(path:string,pin:string):void; }
let signature:BaselineSignature={
  sign(path,pin){const identity=findExistingPreparedSigningIdentity();if(identity.hash.toUpperCase()!==pin.toUpperCase())throw new Error("Baseline signing identity does not match installed pin");signCandidateReceiptResourceBundle(path,identity,"co.tweakers.baseline-receipt");},
  verify:verifyCandidateReceiptResourceBundle,
};
export function setDoctorBaselineSignatureForTest(value:BaselineSignature):()=>void {const previous=signature;signature=value;return()=>{signature=previous;};}
const SIGNATURE_BUNDLE="BaselineReceipt.bundle";
function expectedPin(root:string):string {return JSON.parse(readFileSync(join(dirname(dirname(dirname(root))),"variants/tweakers/state.json"),"utf8")).signingIdentityHash;}
function signBaseline(root:string,pin:string):void {
  const bundle=join(root,SIGNATURE_BUNDLE),resources=join(bundle,"Contents/Resources");mkdirSync(resources,{recursive:true,mode:0o700});
  writePlist(join(bundle,"Contents/Info.plist"),{CFBundleIdentifier:"co.tweakers.baseline-receipt",CFBundleName:"Tweakers Baseline Receipt",CFBundlePackageType:"BNDL",CFBundleVersion:"1"});
  copyFileSync(join(root,"baseline.json"),join(resources,"baseline.json"));signature.sign(bundle,pin);
}
const RECEIPT = "baseline.json";
const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
function fingerprint(value: Omit<DoctorBaselineV1,"fingerprint">): string { return hash(JSON.stringify(value)); }
function safeRelative(path: string): boolean { return !!path && !path.includes("\\") && !path.startsWith("/") && path.split("/").every(p => p && p!=="." && p!==".."); }
/** Logical vendor paths remain provenance; baseline storage has no app layout. */
export function baselineRelativePath(path: string, layoutVersion: 1 | 2 = 2): string | null {
  if (!safeRelative(path)) throw new Error("Unsafe baseline member");
  const cliPrefix = "Contents/Resources/codex-cli/CodexCLI.app/";
  if (path.startsWith(cliPrefix)) {
    const member = path.slice(cliPrefix.length);
    if (layoutVersion === 1) return member === "Contents/MacOS/codex" ? "resources/codex-cli-backend" : null;
    // AMFI requires the original signed Info.plist/resource context. Retain
    // only the CLI dependency, with no .app directory or desktop executable.
    if (/(?:^|\/)[^/]+\.(?:app|framework)(?:\/|$)/i.test(member)) return null;
    return `resources/codex-cli/${member}`;
  }
  if (path === "Contents/Info.plist") return "metadata/Info.plist";
  if (!path.startsWith("Contents/Resources/") || /(?:^|\/)[^/]+\.(?:app|framework)(?:\/|$)/i.test(path)) return null;
  return `resources/${path.slice("Contents/Resources/".length)}`;
}
export function hasDoctorBaseline(root: string): boolean { return existsSync(join(root, RECEIPT)); }
export function doctorSourceFile(root: string, logical: string): string {
  assertLocalExecutionPath(root);
  if (!safeRelative(logical)) throw new Error("Unsafe Doctor source path");
  if (!hasDoctorBaseline(root)) return join(root, logical);
  const layout = logical.startsWith("Contents/Resources/codex-cli/CodexCLI.app/")
    ? (JSON.parse(readFileSync(join(root, RECEIPT), "utf8")) as DoctorBaselineV1).storageLayoutVersion ?? 1 : 2;
  if (layout !== 1 && layout !== 2) throw new Error("Unsupported baseline storage layout");
  const mapped = baselineRelativePath(logical, layout);
  if (!mapped) throw new Error(`Historical source member is not retained: ${logical}`);
  return join(root, mapped);
}
export function readDoctorBaseline(root: string, verify = true): DoctorBaselineV1 {
  return readBaselineContents(root,verify,true);
}
function readBaselineContents(root:string,verify:boolean,requireSignature:boolean):DoctorBaselineV1 {
  assertLocalExecutionPath(root);
  if (lstatSync(root).isSymbolicLink()) throw new Error("Baseline root may not be a symlink");
  const receipt = JSON.parse(readFileSync(join(root, RECEIPT),"utf8")) as DoctorBaselineV1;
  const {fingerprint: expected,...payload}=receipt;
  if (receipt.version!==1 || receipt.kind!=="tweakers-doctor-baseline" || receipt.trust!=="captured-vendor-signature"
    || !/^[a-f0-9]{64}$/.test(receipt.sourceReceiptSha256) || !/^[A-Fa-f0-9]{40}$/.test(receipt.signingIdentityHash)
    || (receipt.storageLayoutVersion !== undefined && receipt.storageLayoutVersion !== 2)
    || !Array.isArray(receipt.files) || fingerprint(payload)!==expected) throw new Error("Invalid baseline receipt");
  const pin=expectedPin(root);
  if(typeof pin!=="string"||pin.toUpperCase()!==receipt.signingIdentityHash.toUpperCase())throw new Error("Baseline external signing pin changed");
  if(requireSignature){
    const bundle=join(root,SIGNATURE_BUNDLE);signature.verify(bundle,pin);
    if(!readFileSync(join(bundle,"Contents/Resources/baseline.json")).equals(readFileSync(join(root,RECEIPT))))throw new Error("Baseline manifest differs from its signed receipt");
  }
  const paths=new Set<string>();
  for(const file of receipt.files) {
    const mapped=baselineRelativePath(file.path, receipt.storageLayoutVersion ?? 1);
    if(!mapped || paths.has(mapped))throw new Error("Invalid baseline inventory");paths.add(mapped);
    if(!verify)continue;
    const path=join(root,mapped),st=lstatSync(path);
    if((st.mode&0o777)!==file.mode)throw new Error(`Baseline permissions changed: ${file.path}`);
    if(file.link!==undefined) {
      if(!st.isSymbolicLink() || readlinkSync(path)!==file.link || !realpathSync(path).startsWith(`${realpathSync(root)}/`))throw new Error("Baseline link changed or escapes storage");
    } else if(!st.isFile() || st.isSymbolicLink() || hash(readFileSync(path))!==file.sha256)throw new Error(`Baseline bytes changed: ${file.path}`);
  }
  if(verify) {
    const walk=(dir:string)=>{for(const name of readdirSync(dir)){const p=join(dir,name);if(dir===root&&name===SIGNATURE_BUNDLE)continue;const st=lstatSync(p);if(name===".DS_Store"&&st.isFile()&&!st.isSymbolicLink())continue;if(st.isDirectory()&&!st.isSymbolicLink())walk(p);else if(relative(root,p)!==RECEIPT&&!paths.has(relative(root,p)))throw new Error("Unexpected baseline payload");}};walk(root);
  }
  return receipt;
}

/** Old flattened CLI evidence remains readable, but cannot be executed on macOS. */
export function doctorBaselineNeedsCliContextUpgrade(root: string): boolean {
  const baseline = readDoctorBaseline(root, false);
  return baseline.storageLayoutVersion !== 2
    && baseline.files.some(file => file.path === "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
}

async function hashFile(path: string): Promise<string> {
  const h=createHash("sha256");for await(const chunk of createReadStream(path))h.update(chunk);return h.digest("hex");
}
/** Selective extraction only; no desktop bundle or executable GUI is restored. */
export async function migrateArchivedDoctorBaseline(input: {
  root: string; archiveReceipt: string; officialReceipt: string; signingIdentityHash: string;
}): Promise<string> {
  return withLocalOperation("baseline migration", () => migrateArchivedDoctorBaselineOwned(input));
}
async function migrateArchivedDoctorBaselineOwned(input: {
  root: string; archiveReceipt: string; officialReceipt: string; signingIdentityHash: string;
}): Promise<string> {
  const archiveReceipt=JSON.parse(readFileSync(input.archiveReceipt,"utf8")) as {
    original:string;archive:string;archiveSHA256:string;retired:boolean;restorationVerified:boolean;
    inventory:Record<string,{type:number;mode:number;size?:number;sha256?:string;link?:string}>;
  };
  if(!archiveReceipt.retired||!archiveReceipt.restorationVerified||!/^[a-f0-9]{64}$/.test(archiveReceipt.archiveSHA256))throw new Error("Archive is not a verified retired payload");
  const sourceBytes=readFileSync(input.officialReceipt),source=JSON.parse(sourceBytes.toString());
  if(source.artifact?.appPath!==archiveReceipt.original || source.source?.trust?.strictSignature!==true || source.source?.trust?.gatekeeper!==true || source.source?.trust?.teamIdentifier!=="2DC432GLL2")throw new Error("Archive source provenance mismatch");
  const generationId=source.generationId;
  if(!/^[a-f0-9-]{36}$/.test(generationId))throw new Error("Invalid baseline generation");
  const parent=join(input.root,"official-source","baselines");mkdirSync(parent,{recursive:true,mode:0o700});
  const target=join(parent,generationId);
  const publishMigration = () => {
    const baseline = readDoctorBaseline(target, false);
    const path = join(input.root, "official-source/baseline-migrations", generationId + ".json");
    const record = {version: 1, generationId, originalAppPath: archiveReceipt.original,
      originalReceiptPath: input.officialReceipt, originalReceiptSha256: hash(sourceBytes),
      archiveReceiptPath: input.archiveReceipt, archiveSha256: archiveReceipt.archiveSHA256,
      baselinePath: target, baselineFingerprint: baseline.fingerprint,
      trust: "Historical vendor signature captured; reduced retained files independently verified"};
    if (existsSync(path) && JSON.stringify(JSON.parse(readFileSync(path,"utf8"))) !== JSON.stringify(record)) throw new Error("Baseline migration record identity changed");
    if (!existsSync(path)) {
      mkdirSync(dirname(path), {recursive: true, mode: 0o700});
      writeDoctorPrivateJson(join(realpathSync(dirname(path)),basename(path)), record);
    }
  };
  if(await hashFile(archiveReceipt.archive)!==archiveReceipt.archiveSHA256)throw new Error("Archive checksum mismatch");
  const {seal:sealed,inventory}=inspectArchiveTree(archiveReceipt.archive,basename(archiveReceipt.original));
  if(sealed.sha256!==source.artifact.treeSeal?.sha256||sealed.entries!==source.artifact.treeSeal?.entries||sealed.bytes!==source.artifact.treeSeal?.bytes)throw new Error("Archive does not reproduce the original official-source tree seal");
  const originalFiles=sourceFilesFromInventory(inventory);
  if(existsSync(target)) {
    const r=readBaselineContents(target,true,existsSync(join(target,SIGNATURE_BUNDLE)));
    if(JSON.stringify(r.originalFiles)!==JSON.stringify(originalFiles))throw new Error("Historical baseline inventory differs from verified archive");
    const retained=Object.keys(inventory).filter(p=>p!=="."&&inventory[p]!.type!==0o040000&&baselineRelativePath(p)).sort();
    if(JSON.stringify(r.files.map(f=>f.path).sort())!==JSON.stringify(retained))throw new Error("Baseline retained inventory is incomplete");
    if(r.sourceReceiptSha256!==hash(sourceBytes)||r.archiveSha256!==archiveReceipt.archiveSHA256)throw new Error("Unsigned baseline provenance changed");
    for(const file of r.files){const original=inventory[file.path];if(!original||original.sha256!==file.sha256||original.link!==file.link||original.mode!==file.mode)throw new Error("Unsigned baseline differs from verified archive");}
    signBaseline(target,input.signingIdentityHash);readDoctorBaseline(target);publishMigration();return target;
  }
  const scratch=join(parent,`.baseline-${randomUUID()}`);mkdirSync(scratch,{mode:0o700});
  const files:BaselineFile[]=[];const writes:Promise<void>[]=[];const found=new Set<string>();const prefix=`${basename(archiveReceipt.original)}/`;
  try {
    await listTar({file:archiveReceipt.archive,onReadEntry(entry){
      if(!entry.path.startsWith(prefix)){entry.resume();return;}
      const logical=entry.path.slice(prefix.length).replace(/\/$/,"");
      if(!logical||!safeRelative(logical)){entry.resume();return;}
      const expected=inventory[logical];const mapped=baselineRelativePath(logical);
      if(!mapped||!expected||expected.type===0o040000){entry.resume();return;}
      if(found.has(logical))throw new Error("Duplicate archive member");found.add(logical);
      const path=join(scratch,mapped);mkdirSync(dirname(path),{recursive:true,mode:0o700});
      // Payload links are created only after all regular files, preventing traversal.
      if(expected.link!==undefined){files.push({path:logical,link:expected.link,mode:expected.mode});entry.resume();return;}
      if(entry.type!=="File"||!expected.sha256)throw new Error("Unexpected archive member type");
      files.push({path:logical,sha256:expected.sha256,mode:expected.mode});
      writes.push(pipeline(entry,createWriteStream(path,{flags:"wx",mode:0o600})).then(()=>{chmodSync(path,expected.mode);}));
    }});await Promise.all(writes);
    for(const [logical,item] of Object.entries(inventory))if(logical!=="."&&item.type!==0o040000&&baselineRelativePath(logical)&&!found.has(logical))throw new Error(`Archive member missing: ${logical}`);
    for(const file of files)if(file.link!==undefined){const path=join(scratch,baselineRelativePath(file.path)!);if(file.link.startsWith("/")||!resolve(dirname(path),file.link).startsWith(`${scratch}/`))throw new Error("Baseline link escapes storage");symlinkSync(file.link,path);}
    for(const required of ["Contents/Info.plist","Contents/Resources/app.asar"])if(!files.some(f=>f.path===required))throw new Error(`Baseline requirement missing: ${required}`);
    if(!files.some(f=>f.path==="Contents/Resources/codex"||f.path==="Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"))throw new Error("Baseline backend requirement missing");
    const payload:Omit<DoctorBaselineV1,"fingerprint">={version:1,storageLayoutVersion:2,kind:"tweakers-doctor-baseline",generationId,originalAppPath:archiveReceipt.original,sourceReceiptSha256:hash(sourceBytes),sourceReceipt:source,archiveSha256:archiveReceipt.archiveSHA256,signingIdentityHash:input.signingIdentityHash,trust:"captured-vendor-signature",originalFiles,files:files.sort((a,b)=>a.path.localeCompare(b.path))};
    writeFileSync(join(scratch,RECEIPT),JSON.stringify({...payload,fingerprint:fingerprint(payload)}),{mode:0o600,flag:"wx"});signBaseline(scratch,input.signingIdentityHash);readDoctorBaseline(scratch);renameSync(scratch,target);publishMigration();return target;
  } catch(error){await Promise.allSettled(writes);rmSync(scratch,{recursive:true,force:true});throw error;}
}


/** Capture review material while the caller holds and revalidates the source lease. */
export function captureDoctorBaseline(root: string, sourceReceipt: {generationId:string;source:{appPath:string};artifact:{appPath:string}}, signingIdentityHash: string, revalidate: () => void): string {
  const source=sourceReceipt.artifact.appPath;
  assertLocalExecutionPath(source);
  const parent=join(root,"official-source","baselines");mkdirSync(parent,{recursive:true,mode:0o700});
  const target=join(parent,sourceReceipt.generationId),scratch=join(parent,`.baseline-${randomUUID()}`);
  if(existsSync(target))throw new Error("Baseline generation already exists");
  mkdirSync(scratch,{mode:0o700});
  const files:BaselineFile[]=[], originalFiles:DoctorSourceFileEvidence[]=[];
  try {
    const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){
      if(name===".DS_Store"||name.startsWith("._"))continue;
      const path=join(dir,name),logical=relative(source,path),st=lstatSync(path);
      if(st.isDirectory()&&!st.isSymbolicLink()){walk(path);continue;}
      if(!st.isFile()&&!st.isSymbolicLink())throw new Error("Unsupported source member");
      const link=st.isSymbolicLink()?readlinkSync(path):undefined;
      const sha=hash(link===undefined?readFileSync(path):`symlink:${link}`);
      originalFiles.push({path:logical,kind:link===undefined?"file":"symlink",bytes:link===undefined?st.size:Buffer.byteLength(link),sha256:`sha256:${sha}`,...(link===undefined?{}:{linkTarget:link})});
      const mapped=baselineRelativePath(logical);if(!mapped)continue;
      const destination=join(scratch,mapped);mkdirSync(dirname(destination),{recursive:true,mode:0o700});
      if(link===undefined){copyFileSync(path,destination);chmodSync(destination,st.mode&0o777);files.push({path:logical,sha256:sha,mode:st.mode&0o777});}
      else files.push({path:logical,link,mode:st.mode&0o777});
    }};walk(source);
    for(const file of files)if(file.link!==undefined){const path=join(scratch,baselineRelativePath(file.path)!);if(file.link.startsWith("/")||!resolve(dirname(path),file.link).startsWith(`${scratch}/`))throw new Error("Baseline link escapes storage");symlinkSync(file.link,path);}
    const payload:Omit<DoctorBaselineV1,"fingerprint">={version:1,storageLayoutVersion:2,kind:"tweakers-doctor-baseline",generationId:sourceReceipt.generationId,originalAppPath:source,sourceReceiptSha256:hash(JSON.stringify(sourceReceipt)),sourceReceipt,archiveSha256:null,signingIdentityHash,trust:"captured-vendor-signature",files:files.sort((a,b)=>a.path.localeCompare(b.path)),originalFiles:originalFiles.sort((a,b)=>a.path.localeCompare(b.path))};
    writeFileSync(join(scratch,RECEIPT),JSON.stringify({...payload,fingerprint:fingerprint(payload)}),{mode:0o600,flag:"wx"});signBaseline(scratch,signingIdentityHash);readDoctorBaseline(scratch);revalidate();renameSync(scratch,target);return target;
  }catch(error){rmSync(scratch,{recursive:true,force:true});throw error;}
}


/** Reconstruct the original seal directly from an uncompressed archive, without restoring an app. */
export function sealArchiveTree(archive:string,appName:string):{sha256:string;entries:number;bytes:string} {
  return inspectArchiveTree(archive,appName).seal;
}
function inspectArchiveTree(archive:string,appName:string):{seal:{sha256:string;entries:number;bytes:string};inventory:Record<string,ArchiveMember>} {
  const inventory:Record<string,ArchiveMember>={};
  const fd=openSync(archive,"r");
  try {
    const members=new Map<string,{header:Header;offset:number}>();let offset=0,extended:Pax|undefined,global:Pax|undefined;
    for(;;){const block=Buffer.alloc(512);if(readSync(fd,block,0,512,offset)!==512)throw new Error("Truncated source archive");
      const raw=new Header(block);if(raw.nullBlock)break;if(!raw.cksumValid)throw new Error("Invalid archive header");
      const metadata=raw.type==="ExtendedHeader"||raw.type==="GlobalExtendedHeader";
      const h=metadata?raw:new Header(block,0,extended,global),size=h.size??0;if(!Number.isSafeInteger(size)||size<0)throw new Error("Invalid archive member size");
      const dataOffset=offset+512;offset=dataOffset+Math.ceil(size/512)*512;
      if(raw.type==="ExtendedHeader"||raw.type==="GlobalExtendedHeader"){
        const meta=Buffer.alloc(raw.size??0);if(meta.length>16*1024*1024||readSync(fd,meta,0,meta.length,dataOffset)!==meta.length)throw new Error("Invalid archive metadata");
        if(raw.type==="GlobalExtendedHeader")global=Pax.parse(meta.toString(),global,true);else extended=Pax.parse(meta.toString(),extended);continue;
      }
      if(extended?.path)h.path=extended.path;
      if(extended?.linkpath)h.linkpath=extended.linkpath;
      extended=undefined;const p=(h.path??"").replace(/\/$/,"");if(p!==appName&&!p.startsWith(appName+"/"))continue;
      const name=p===appName?"":p.slice(appName.length+1);if(name&&(!safeRelative(name)||name.split("/").some(n=>n===".DS_Store"||n.startsWith("._"))))continue;
      if(members.has(name))throw new Error("Duplicate sealed archive member");members.set(name,{header:h,offset:dataOffset});
    }
    const digest=createHash("sha256");digest.update("tweakers-official-source-tree-v1\0");let entries=0,bytes=0n;
    const visit=(name:string)=>{const member=members.get(name);if(!member)throw new Error("Archive directory missing");const h=member.header;
      digest.update(name).update("\0").update(String((h.mode??0)&0o7777)).update("\0").update(String(h.uid)).update("\0").update(String(h.gid)).update("\0");entries++;
      if(h.type==="Directory"){
        inventory[name||"."]={type:0o040000,uid:h.uid??undefined,gid:h.gid??undefined,fullMode:(h.mode??0)&0o7777,mode:(h.mode??0)&0o777};
        digest.update("directory\0");const children=[...members.keys()].filter(p=>p!==name&&(name?dirname(p)===name:!p.includes("/"))).sort((a,b)=>basename(a).localeCompare(basename(b)));for(const child of children)visit(child);
      } else if(h.type==="File"||h.type==="OldFile") {
        const content=createHash("sha256");const size=h.size??0;digest.update("file\0").update(String(size)).update("\0");bytes+=BigInt(size);const buffer=Buffer.alloc(Math.min(size,1024*1024));let done=0;
        while(done<size){const n=readSync(fd,buffer,0,Math.min(buffer.length,size-done),member.offset+done);if(n===0)throw new Error("Truncated archive payload");digest.update(buffer.subarray(0,n));content.update(buffer.subarray(0,n));done+=n;}
        inventory[name]={offset:member.offset,type:0o100000,uid:h.uid??undefined,gid:h.gid??undefined,fullMode:(h.mode??0)&0o7777,mode:(h.mode??0)&0o777,size,sha256:content.digest("hex")};
      } else if(h.type==="SymbolicLink"){inventory[name]={type:0o120000,uid:h.uid??undefined,gid:h.gid??undefined,fullMode:(h.mode??0)&0o7777,mode:(h.mode??0)&0o777,link:h.linkpath??""};digest.update("symlink\0").update(h.linkpath??"").update("\0");}
      else throw new Error("Unsupported sealed archive member");
    };visit("");return {seal:{sha256:digest.digest("hex"),entries,bytes:bytes.toString()},inventory};
  }finally{closeSync(fd);}
}

function sourceFilesFromInventory(inventory:Record<string,ArchiveMember>):DoctorSourceFileEvidence[] {return Object.entries(inventory).filter(([p,v])=>p!=="."&&v.type!==0o040000&&!p.split("/").some(n=>n===".DS_Store"||n.startsWith("._"))).map(([path,v])=>({path,kind:v.link===undefined?"file" as const:"symlink" as const,bytes:v.link===undefined?v.size!:Buffer.byteLength(v.link),sha256:`sha256:${v.link===undefined?v.sha256:hash(`symlink:${v.link}`)}` as `sha256:${string}`,...(v.link===undefined?{}:{linkTarget:v.link})})).sort((a,b)=>a.path.localeCompare(b.path));}

/** An interrupted deletion may resume only for remaining bytes covered by the verified archive. */
export function assertSurvivingArchiveMembers(archive: string, appName: string, root: string): void {
  const { inventory } = inspectArchiveTree(archive, appName);
  const visit = (path: string): void => {
    const key = relative(root, path) || ".", expected = inventory[key], stat = lstatSync(path);
    if (!expected || (stat.mode & 0o170000) !== expected.type || (stat.mode & 0o7777) !== expected.fullMode
      || stat.uid !== expected.uid || stat.gid !== expected.gid) throw new Error("Unarchived retirement member or metadata: " + key);
    if (stat.isSymbolicLink()) {
      if (readlinkSync(path) !== expected.link) throw new Error("Retirement symlink changed: " + key);
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (!stat.isFile() || stat.size !== expected.size || hash(readFileSync(path)) !== expected.sha256) {
      throw new Error("Unarchived retirement bytes: " + key);
    }
  };
  visit(root);
}

/** Repair only ordinary restored file bytes from the independently sealed raw archive.
 * macOS tar can restore a compressed file's metadata without its logical bytes.
 * Restore sealed ownership when native extraction uses the caller group.
 * Link targets and xattrs remain the native extractor's work and are independently checked.
 */
export function restoreSealedArchiveFileContents(archive:string,appName:string,root:string,expectedSeal:{sha256:string;entries:number;bytes:string}):void {
  const observed=inspectArchiveTree(archive,appName);
  if(observed.seal.sha256!==expectedSeal.sha256||observed.seal.entries!==expectedSeal.entries
    ||observed.seal.bytes!==expectedSeal.bytes)throw new Error("Restoration archive identity changed");
  const base=realpathSync(root),source=openSync(archive,constants.O_RDONLY|constants.O_NOFOLLOW);
  const buffer=Buffer.alloc(1024*1024);
  try {
    for(const [path,member] of Object.entries(observed.inventory)) {
      const target=join(base,path);
      if(member.type===0o120000) {
        if(realpathSync(dirname(target))!==dirname(target))throw new Error("Restoration member traverses a link");
        const stat=lstatSync(target);
        if(!stat.isSymbolicLink()||readlinkSync(target)!==member.link)throw new Error("Restoration symlink changed");
        if(stat.uid!==member.uid||stat.gid!==member.gid) {
          if(member.uid===undefined||member.gid===undefined)throw new Error("Missing sealed ownership");
          lchownSync(target,member.uid,member.gid);
        }
        continue;
      }
      if(realpathSync(target)!==target)throw new Error("Restoration member traverses a link");
      let fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW|(member.type===0o040000?constants.O_DIRECTORY:0));
      try {
        const stat=fstatSync(fd);
        if(member.type===0o040000) {
          if(!stat.isDirectory())throw new Error("Restoration directory changed");
          if(stat.uid!==member.uid||stat.gid!==member.gid) {
            if(member.uid===undefined||member.gid===undefined)throw new Error("Missing sealed ownership");
            fchownSync(fd,member.uid,member.gid);
            fchmodSync(fd,stat.mode&0o7777);
          }
          continue;
        }
        if(!stat.isFile()||stat.nlink!==1)throw new Error("Restoration target is not an independent regular file");
        if(stat.uid!==member.uid||stat.gid!==member.gid){
          if(member.uid===undefined||member.gid===undefined)throw new Error("Missing sealed ownership");
          fchownSync(fd,member.uid,member.gid);
          fchmodSync(fd,stat.mode&0o7777);
        }
        const digest=createHash("sha256");let cursor=0,count;
        while((count=readSync(fd,buffer,0,buffer.length,cursor))>0){digest.update(buffer.subarray(0,count));cursor+=count;}
        if(cursor===member.size&&digest.digest("hex")===member.sha256)continue;
        closeSync(fd);fd=-1;
        const mode=stat.mode&0o7777;
        chmodSync(target,mode|0o200);
        try {
        fd=openSync(target,constants.O_RDWR|constants.O_NOFOLLOW);
        if(fstatSync(fd).ino!==stat.ino||fstatSync(fd).dev!==stat.dev)throw new Error("Restoration target changed");
        cursor=0;
        while(cursor<member.size!) {
          const count=readSync(source,buffer,0,Math.min(buffer.length,member.size!-cursor),member.offset!+cursor);
          if(!count)throw new Error("Truncated restoration member");
          let written=0;while(written<count)written+=writeSync(fd,buffer,written,count-written,cursor+written);
          cursor+=count;
        }
        ftruncateSync(fd,member.size!);fsyncSync(fd);
        }finally{chmodSync(target,mode);}
      }finally{if(fd>=0)closeSync(fd);}
    }
  }finally{closeSync(source);}
}

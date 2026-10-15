import { assertAcceptedRuntimeRepairHeadContract, assertAcceptedRuntimeRepairIntentContract, assertAcceptedRuntimeRepairPublicationContract, assertAcceptedRuntimeRepairOriginalCustodyContract, assertAcceptedBackendTransitionJournalBindingContract, parseAcceptedRuntimeRepairJson, NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1, type AcceptedRuntimeRepairPredecessorV1 } from "@therealityreport/tweakers-sdk";
import { preserveDoctorAdoptionHistory } from "./doctor-adoption-history.js";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statfsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertArchiveVolume, readArtifactRetentionPolicy, restorationMetadata } from "./artifact-retirement.js";
import { sealArchiveTree } from "./doctor-baseline.js";
import { writeDoctorPrivateJson } from "./doctor-store.js";
import { lifecycleLockFile, outsideLifecycleContext, withLifecycleLock } from "./lifecycle-lock-core.js";
import { isLifecycleLockHeld } from "./lifecycle-lock.js";
import { outsideLocalOperationContext, readLocalOperation, withLocalOperation } from "./local-operation.js";
import { TWEAKERS_MANAGER_ID } from "./manager-contract.js";
import { parsePreparedOperation } from "./manager-operation-store.js";
import { managerOperationHasSafePrepublicationFailure, managerOperationRecoveryIsVerified, readManagerRecoveryBinding } from "./manager-recovery-evidence.js";
import { canonicalTweakersManagerRoot, readTweakersManagerGenerationBindings, tweakersManagerDescriptorPaths } from "./manager-descriptor.js";
import { sealHistoricalArtifactTree } from "./official-source-registration.js";
import { targetUserHome } from "./ownership.js";
import { acquireProcessLock, isLockHeldByLiveOwner, processIdentityAlive, readLockOwner } from "./process-lock.js";
import { fingerprintVariantGeneration } from "./variant-generation.js";

/**
 * Two-version retention for every generation family that updates recreate.
 * Keep CURRENT + PREVIOUS of each family plus anything an active operation,
 * lock, pending transaction, running process, or the installed/rollback apps
 * still reference. Everything else is archived (never permanently deleted
 * before a verified archive exists). Ambiguous references always retain.
 */

export const GENERATION_FAMILIES = [
  "manager-generations", "manager-runtime-generations", "manager-managed-runtime-generations",
  "doctor-jobs", "doctor-analysis-checkpoints", "doctor-maintenance", "doctor-implementation-acceptance",
  "official-source-baselines", "variant-previous", "variant-builds",
] as const;
export type GenerationFamily = typeof GENERATION_FAMILIES[number];
export type GenerationDecision = "keep" | "retire" | "ambiguous";

export interface GenerationRetentionEntry {
  family: GenerationFamily; name: string; path: string; bytes: number; mtimeMs: number;
  identity: { dev: number; ino: number } | null; decision: GenerationDecision; reasons: string[];
}
export interface GenerationFamilySummary {
  directory: string; blocked: string | null;
  keep: { count: number; bytes: number }; retire: { count: number; bytes: number }; ambiguous: { count: number; bytes: number };
}
export interface GenerationRetentionPlan {
  version: 1; kind: "tweakers-generation-retention-plan"; root: string; createdAt: string;
  /** Any blocker prevents apply; the plan itself remains a read-only inventory. */
  blockers: string[]; notes: string[];
  families: Record<GenerationFamily, GenerationFamilySummary>;
  entries: GenerationRetentionEntry[];
}
export interface GenerationRetentionOptions {
  /** Test seam; production resolves Menu Bar's descriptor directory. */
  descriptorRoot?: string;
  /** Test seam; production reads `ps` command lines. */
  processCommands?: () => string[];
  /** Internal: apply already owns lifecycle, promotion and source locks. */
  locksOwnedByCaller?: boolean;
  /** Internal eligibility-only scan: retain reference closure without running du. */
  includeSizes?: boolean;
}
export interface ApplyGenerationRetentionOptions extends GenerationRetentionOptions {
  /** Test seam: throw when the archive volume is unavailable. */
  assertArchive?: (volume: string, uuid: string | null) => void;
  /** Test seam overriding `<archive>/_Mac-Archive/Tweakers/retired-generations`. */
  archiveRoot?: string;
  trashRoot?: string;
  /** Per-run budget; triggered runs stay bounded so they never hold locks for long. */
  maxBytes?: number;
  /** Fail instead of waiting for another local operation. */
  wait?: boolean;
}
export interface GenerationRetentionResult {
  planCreatedAt: string;
  retired: Array<{ family: GenerationFamily; name: string; path: string; bytes: number; kind: "archive" | "trash"; destination: string; receipt: string }>;
  skipped: Array<{ family: GenerationFamily; name: string; path: string; reason: string }>;
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const JUNK = new Set([".DS_Store"]);
const MAX_JSON = 8 * 1024 * 1024;

type JsonRead = { state: "missing" } | { state: "invalid"; error: string } | { state: "ok"; value: Record<string, unknown>; text: string };
function readJson(path: string, maxBytes = MAX_JSON): JsonRead {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "invalid", error: message(error) };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { state: "invalid", error: "not a regular file" };
  if (stat.size > maxBytes) return { state: "invalid", error: "too large" };
  try {
    const text = readFileSync(path, "utf8"), value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "invalid", error: "not a JSON object" };
    return { state: "ok", value, text };
  } catch (error) { return { state: "invalid", error: message(error) }; }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const str = (value: unknown): string | null => typeof value === "string" ? value : null;
function listDir(path: string): string[] {
  try { return readdirSync(path).filter(name => !JUNK.has(name)).sort(); } catch { return []; }
}
function topLevelJsonTexts(dir: string, limit = 64): string[] {
  const texts: string[] = [];
  for (const name of listDir(dir).filter(name => name.endsWith(".json")).slice(0, limit)) {
    const read = readJson(join(dir, name), 1024 * 1024);
    if (read.state === "ok") texts.push(read.text);
  }
  return texts;
}
function measureBytes(path: string): number {
  try {
    const out = execFileSync("/usr/bin/du", ["-sk", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 600_000, maxBuffer: 1024 * 1024 });
    const kib = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isSafeInteger(kib) ? kib * 1024 : 0;
  } catch (error) {
    // du exits non-zero for unreadable members but still reports a total.
    const out = String((error as { stdout?: unknown }).stdout ?? "");
    const kib = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isSafeInteger(kib) ? kib * 1024 : 0;
  }
}
function defaultProcessCommands(): string[] {
  try {
    return execFileSync("/bin/ps", ["-axww", "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }).split("\n");
  } catch { throw new Error("Cannot enumerate running processes; retention is blocked"); }
}

function familyDirectories(root: string): Record<GenerationFamily, string> {
  const manager = join(root, "managers", TWEAKERS_MANAGER_ID), doctor = join(root, "doctor"), variant = join(root, "variants", "tweakers");
  return {
    "manager-generations": join(manager, "generations"),
    "manager-runtime-generations": join(manager, "runtime-generations"),
    "manager-managed-runtime-generations": join(manager, "managed-runtime-generations"),
    "doctor-jobs": join(doctor, "jobs"),
    "doctor-analysis-checkpoints": join(doctor, "analysis-checkpoints"),
    "doctor-maintenance": join(doctor, "maintenance"),
    "doctor-implementation-acceptance": join(doctor, "implementation-acceptance"),
    "official-source-baselines": join(root, "official-source", "baselines"),
    "variant-previous": join(variant, "previous"),
    "variant-builds": join(variant, "builds"),
  };
}
function expectedName(family: GenerationFamily, name: string): boolean {
  if (family.startsWith("manager-") || family === "doctor-analysis-checkpoints") return HEX64.test(name);
  if (family === "doctor-implementation-acceptance") return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);
  return UUID.test(name);
}

function pathReferences(directory: string, text: string): string[] {
    const prefix = directory + "/", found = new Set<string>();
    for (let at = text.indexOf(prefix); at >= 0; at = text.indexOf(prefix, at + prefix.length)) {
      const name = /^[^/"\s\\]+/.exec(text.slice(at + prefix.length))?.[0];
      if (name) found.add(name);
    }
    return [...found];
}

/** Conservative reference custody, never staging or executable authorization. */
function runtimeRepairRetentionReferences(root:string,headPath:string,priorBinding?:AcceptedRuntimeRepairPredecessorV1 & {operationId:string;promotionId:string}):string[] {
  const hash=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
  const fail=(reason:string):never=>{throw new Error(`Runtime repair retention: ${reason}`);};
  const ancestry=(path:string)=>{
    if(path!==resolve(path)||!path.startsWith(root+"/")||realpathSync(root)!==root||realpathSync(path)!==path)fail("foreign or linked proof path");
    const chain:Array<{path:string;status:NonNullable<ReturnType<typeof lstatSync>>}>=[];
    for(let cursor=dirname(path);;cursor=dirname(cursor)){
      const status=lstatSync(cursor);
      if(!status.isDirectory()||status.isSymbolicLink()||status.uid!==process.getuid?.()||(status.mode&0o022)!==0)fail("unsafe proof ancestry");
      chain.push({path:cursor,status});if(cursor===root)break;
    }
    return chain;
  };
  const read=(path:string,accepted=false):Buffer=>{
    const chain=ancestry(path),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const before=fstatSync(fd);
      if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o077)!==0||before.size>MAX_JSON
        ||(before.nlink!==1&&!(accepted&&before.nlink===2)))fail("unsafe immutable proof leaf");
      if(accepted&&before.nlink===2){
        if(!UUID.test(basename(dirname(path)))||dirname(dirname(path))!==join(root,"codex-source","accepted")||basename(path)!=="accepted-build.json"||(before.mode&0o777)!==0o600)fail("foreign accepted publisher link");
        const aliases=readdirSync(dirname(path)).filter(name=>/^\.accepted-build\.json\.[1-9][0-9]*\.[0-9]+\.tmp$/.test(name)).filter(name=>{
          const candidate=join(dirname(path),name),status=lstatSync(candidate);
          if(status.dev!==before.dev||status.ino!==before.ino)return false;
          ancestry(candidate);
          if(!status.isFile()||status.uid!==before.uid||status.gid!==before.gid||status.mode!==before.mode||status.nlink!==2)fail("publisher alias differs");
          return true;
        });
        if(aliases.length!==1)fail("accepted proof lacks exact publisher alias");
      }
      const bytes=readFileSync(fd),after=fstatSync(fd),named=lstatSync(path);
      for(const key of ["dev","ino","uid","gid","mode","size","nlink","mtimeMs","ctimeMs"] as const)
        if(before[key]!==after[key]||before[key]!==named[key])fail("proof changed during read");
      for(const entry of chain){const now=lstatSync(entry.path);for(const key of ["dev","ino","uid","gid","mode"] as const)if(now[key]!==entry.status[key])fail("proof ancestry changed");}
      return bytes;
    }finally{closeSync(fd);}
  };
  const deps={isCanonicalAbsolutePath:(path:string)=>path===resolve(path)&&path.startsWith("/"),sha256:(text:string)=>hash(text)};
  for(let cursor=dirname(headPath);;cursor=dirname(cursor)){if((lstatSync(cursor).mode&0o077)!==0)fail("head ancestry is not owner-private");if(cursor===root)break;}
  const headBytes=read(headPath),head:unknown=parseAcceptedRuntimeRepairJson(headBytes.toString("utf8"));
  assertAcceptedRuntimeRepairHeadContract(head);
  if(priorBinding) {
    if(head.version!==1||head.prior!==null||head.operationId!==priorBinding.operationId||head.promotionId!==priorBinding.promotionId||head.repairId!==priorBinding.repairId||head.intentSha256!==priorBinding.intentSha256||hash(headBytes)!==priorBinding.headSha256)fail("retained predecessor head differs");
  }else if(headPath!==join(root,"transactions","manager-recovery-bindings",`${head.operationId}.runtime-repair-head.json`))fail("head is foreign");
  const child=join(root,"variants","tweakers","builds",head.promotionId,"runtime-repair","accepted","operations",head.repairId);
  if(priorBinding&&headPath!==join(child,"head.json"))fail("predecessor path is foreign");
  for(let cursor=child;;cursor=dirname(cursor)){if((lstatSync(cursor).mode&0o077)!==0)fail("intent ancestry is not owner-private");if(cursor===join(root,"variants","tweakers"))break;}
  const intentBytes=read(join(child,"intent.json"));
  if(hash(intentBytes)!==head.intentSha256||!headBytes.equals(read(join(child,"head.json"))))fail("head and intent bytes differ");
  const intent:unknown=parseAcceptedRuntimeRepairJson(intentBytes.toString("utf8"));assertAcceptedRuntimeRepairIntentContract(intent,deps);
  if(intent.operationId!==head.operationId||intent.promotionId!==head.promotionId||intent.repairId!==head.repairId||intent.version!==head.version||JSON.stringify(intent.prior)!==JSON.stringify(head.prior))fail("intent identities differ");
  const authority=intent.authority;
  if(priorBinding&&intent.authorityReceipt.jsonSha256!==priorBinding.authorityReceiptSha256)fail("predecessor receipt differs");
  if(priorBinding) {
    const publication:unknown=parseAcceptedRuntimeRepairJson(read(join(child,"publication.json")).toString("utf8"));assertAcceptedRuntimeRepairPublicationContract(publication);
    if(publication.phase!=="challenge:published"||publication.operationId!==head.operationId||publication.promotionId!==head.promotionId||publication.repairId!==head.repairId
      ||publication.intentSha256!==head.intentSha256||existsSync(join(child,"acceptance.json"))||existsSync(join(child,"acceptance-source.json")))fail("predecessor is no longer an unaccepted challenge");
  }
  const originalJournalBytes=read(authority.originals.journal.snapshot.path);
  const originalJournal=parseAcceptedRuntimeRepairJson(originalJournalBytes.toString("utf8")) as Record<string,unknown>;
  const originalLane=originalJournal.acceptedBackendTransition;assertAcceptedBackendTransitionJournalBindingContract(originalLane,deps);
  if(originalLane.lane.version!==1)return fail("Historical runtime repair retention requires its original custom-backend authority");
  if(originalLane.operationId!==head.operationId||originalLane.lane.identity.userRoot!==join(root,"variants","tweakers"))fail("original lane is foreign");
  const accepted=originalLane.lane.authority.acceptedBuildReceipt;
  if(authority.originals.acceptedBuildReceipt.path!==join(root,"codex-source","accepted",originalLane.lane.authority.transactionId,"accepted-build.json")
    ||authority.originals.acceptedBuildReceipt.path!==accepted.path||authority.originals.acceptedBuildReceipt.sha256!==accepted.sha256)fail("accepted authority path differs from original lane");
  const refs=[authority.originals.recoveryBinding,authority.originals.preparedCasIntent,authority.originals.custody,authority.originals.acceptedBuildReceipt,
    authority.originals.operation.snapshot,authority.originals.journal.snapshot,authority.originals.expectation.snapshot,
    authority.completedCas.prior,authority.completedCas.completed,authority.sourceDelta.originalSourceVerification,
    authority.sourceDelta.repairedSourceVerification,authority.sourceDelta.reviewedDelta,intent.consumedApproval,intent.effectiveJournal,intent.effectiveActiveReceipt];
  for(const [ref,name] of [[authority.originals.operation.snapshot,"original-operation.json"],[authority.originals.journal.snapshot,"original-journal.json"],
    [authority.originals.expectation.snapshot,"original-expectation.json"],[authority.originals.custody,"original-custody.json"],
    [intent.consumedApproval,"consumed-doctor-approval.json"],[intent.effectiveJournal,"effective-journal.json"],[intent.effectiveActiveReceipt,"effective-active-receipt.json"]] as const)
    if(ref.path!==join(child,name))fail("foreign fixed child proof");
  for(const ref of refs)if(hash(read(ref.path,ref===authority.originals.acceptedBuildReceipt))!==ref.sha256)fail("bound proof digest differs");
  const custody:unknown=parseAcceptedRuntimeRepairJson(read(authority.originals.custody.path).toString("utf8"));assertAcceptedRuntimeRepairOriginalCustodyContract(custody,deps);
  if(custody.operationId!==head.operationId||custody.promotionId!==head.promotionId||JSON.stringify(custody.originalWorker)!==JSON.stringify(authority.originalWorker))fail("original worker custody differs");
  const bundle=join(child,"receipt","TweakersRuntimeRepairReceipt.bundle"),authorityPath=join(bundle,"Contents","Resources","runtime-repair.json");
  const authorityBytes=read(authorityPath);
  if(hash(authorityBytes)!==intent.authorityReceipt.jsonSha256||JSON.stringify(parseAcceptedRuntimeRepairJson(authorityBytes.toString("utf8")))!==JSON.stringify(authority))fail("signed authority bytes differ");
  if(hash(read(custody.originalCandidateReceipt.json.path))!==custody.originalCandidateReceipt.json.sha256)fail("original signed candidate proof differs");
  const expectedJobRoot=join(root,"doctor","jobs")+"/";
  if(!custody.originalCandidateReceipt.bundlePath.startsWith(expectedJobRoot))fail("original signed candidate is foreign");
  const candidateJob=custody.originalCandidateReceipt.bundlePath.slice(expectedJobRoot.length).split("/")[0]!;
  if(!UUID.test(candidateJob)||custody.originalCandidateReceipt.bundlePath!==join(root,"doctor","jobs",candidateJob,"candidate","receipt","TweakersCandidateReceipt.bundle")
    ||custody.originalCandidateReceipt.json.path!==join(custody.originalCandidateReceipt.bundlePath,"Contents","Resources","variant-candidate-receipt.json"))fail("candidate job identity is invalid");
  for(const proofBundle of [bundle,custody.originalCandidateReceipt.bundlePath]){
    ancestry(join(proofBundle,"Contents"));const status=lstatSync(proofBundle);
    if(!status.isDirectory()||status.isSymbolicLink()||status.uid!==process.getuid?.()||(status.mode&0o022)!==0)fail("signed proof bundle is missing or unsafe");
  }
  const references=[child,join(root,"variants","tweakers","previous",head.promotionId),custody.originalCandidateReceipt.bundlePath];
  if(authority.version===2) {
    const previous=authority.predecessor,previousRoot=join(root,"variants","tweakers","builds",head.promotionId,"runtime-repair","accepted","operations",previous.binding.repairId);
    if(previous.publication.path!==join(previousRoot,"publication.json")||previous.challenge.snapshot.path!==join(child,"predecessor-challenge.json")
      ||previous.challenge.sourcePath!==join(root,"variants","tweakers","runtime-ready-expectation.json")||previous.challenge.sourceSha256AtCapture!==previous.challenge.snapshot.sha256)fail("successor predecessor proof paths differ");
    for(const ref of [previous.publication,previous.challenge.snapshot])if(hash(read(ref.path))!==ref.sha256)fail("successor predecessor proof changed");
    references.push(...runtimeRepairRetentionReferences(root,join(previousRoot,"head.json"),{...previous.binding,operationId:head.operationId,promotionId:head.promotionId}));
  }
  for(const worker of [authority.originalWorker,authority.authorizedWorker]){
    const generation=join(root,"managers",TWEAKERS_MANAGER_ID,"generations",worker.generationId);
    if(worker.launcherPath!==join(generation,"Tweakers Manager Launcher")||hash(read(worker.launcherPath))!==worker.launcherSha256||hash(read(join(generation,"target.seal")))!==worker.sealSha256)fail("worker custody is missing or changed");
    const binding=readTweakersManagerGenerationBindings(generation);
    const runtimeRoot=join(root,"managers",TWEAKERS_MANAGER_ID,"runtime-generations",binding.runtimeFingerprint),
      managedRuntimeRoot=join(root,"managers",TWEAKERS_MANAGER_ID,"managed-runtime-generations",binding.managedRuntimeFingerprint);
    for(const directory of [runtimeRoot,managedRuntimeRoot]){
      ancestry(directory);
      const status=lstatSync(directory);if(!status.isDirectory()||status.isSymbolicLink())fail("worker dependency closure is missing");
    }
    references.push(generation,runtimeRoot,managedRuntimeRoot);
  }
  // Include only verified proof text for existing family token extraction.
  references.push(read(authority.originals.journal.snapshot.path).toString("utf8"));
  if(!headBytes.equals(read(headPath))||hash(read(join(child,"intent.json")))!==head.intentSha256)fail("head or intent changed during inventory");
  return references;
}

/** Conservative custody only. A signed handoff remains an installer dependency
 * after its old operation is failed. This inventory grants no execution or
 * signature acceptance; incomplete custody blocks retirement instead. */
function nativeReplacementRetentionReferences(root: string, operationId: string): string[] {
  const fail = (reason: string): never => { throw new Error(`Native replacement retention: ${reason}`); };
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const safePath = (path: string): void => {
    if (path !== resolve(path) || !path.startsWith(root + "/") || realpathSync(root) !== root || realpathSync(path) !== path) fail("foreign or linked proof path");
    for (let cursor = dirname(path);; cursor = dirname(cursor)) {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) fail("unsafe proof ancestry");
      if (cursor === root) break;
    }
  };
  const read = (path: string): Buffer => {
    safePath(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.nlink !== 1 || before.size > MAX_JSON) fail("unsafe proof leaf");
      const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(path);
      for (const field of ["dev", "ino", "uid", "gid", "mode", "size", "nlink", "mtimeMs", "ctimeMs"] as const)
        if (before[field] !== after[field] || before[field] !== named[field]) fail("proof changed during read");
      safePath(path);
      return bytes;
    } finally { closeSync(fd); }
  };
  if (!UUID.test(operationId)) fail("invalid fixed operation directory");
  const directory = join(root, "transactions", "native-replacements", operationId), draft = read(join(directory, "intent.json"));
  const signed = read(join(directory, "intent.bundle", "Contents", "Resources", "receipt.json"));
  const decoded: unknown = parseAcceptedRuntimeRepairJson(signed.toString("utf8"));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) fail("intent is not an object");
  const intent = decoded as Record<string, any>;
  const keys = ["version", "kind", "operationId", "promotionId", "repairId", "replacementId", "createdAt", "trustedLeafSha1", "worker", "originalOperation", "retained", "unchanged", "previousApp", "nativeRequest"];
  if (Object.keys(intent).sort().join(",") !== keys.sort().join(",")
    || intent.version !== 1 || intent.kind !== "tweakers-native-replacement-intent" || intent.operationId !== operationId
    || !UUID.test(intent.promotionId) || !UUID.test(intent.replacementId) || (intent.repairId !== null && !UUID.test(intent.repairId))
    || intent.trustedLeafSha1 !== NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1 || intent.originalOperation?.operationId !== operationId
    || !Array.isArray(intent.retained) || intent.retained.length < 3 || intent.retained.length > 32
    || !Array.isArray(intent.unchanged) || intent.unchanged.length < 5 || intent.unchanged.length > 32
    || (intent.nativeRequest === null ? intent.repairId !== null : intent.nativeRequest?.version !== 2 || intent.nativeRequest.officialBundled?.transactionId !== intent.replacementId)
    || !isDeepStrictEqual(parseAcceptedRuntimeRepairJson(draft.toString("utf8")), intent)) fail("intent binding differs");
  const worker = intent.worker, generation = join(root, "managers", TWEAKERS_MANAGER_ID, "generations", worker?.generationId ?? "");
  if (!worker || !HEX64.test(worker.generationId) || worker.launcherPath !== join(generation, "Tweakers Manager Launcher")
    || hash(read(worker.launcherPath)) !== worker.launcherSha256 || hash(read(join(generation, "target.seal"))) !== worker.sealSha256) fail("bound worker is missing or changed");
  const bindings = readTweakersManagerGenerationBindings(generation);
  const references = [generation, join(root, "managers", TWEAKERS_MANAGER_ID, "runtime-generations", bindings.runtimeFingerprint),
    join(root, "managers", TWEAKERS_MANAGER_ID, "managed-runtime-generations", bindings.managedRuntimeFingerprint)];
  for (const path of references) {
    safePath(path);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) fail("worker dependency closure is missing or unsafe");
  }
  const journal = join(root, "variants", "tweakers", "transactions", "variant-promotion", `${intent.promotionId}.json`), seen = new Set<string>();
  for (const entry of intent.retained) {
    if (!entry || typeof entry.path !== "string" || Object.keys(entry).sort().join(",") !== "generation,path" || seen.has(entry.path)) fail("retained proof is malformed");
    safePath(entry.path);
    if (!isDeepStrictEqual(fingerprintVariantGeneration(entry.path), entry.generation)) fail("retained proof changed");
    seen.add(entry.path); references.push(entry.path);
  }
  if (!seen.has(journal)) fail("original journal is missing");
  if (!draft.equals(read(join(directory, "intent.json"))) || !signed.equals(read(join(directory, "intent.bundle", "Contents", "Resources", "receipt.json")))) fail("intent changed during inventory");
  return references;
}

/** Pure, read-only inventory. It never mutates the root or any lock claim. */
export function planGenerationRetention(root: string, options: GenerationRetentionOptions = {}): GenerationRetentionPlan {
  const exactRoot = resolve(root);
  if (exactRoot !== root) throw new Error("Generation retention root must be an exact absolute path");
  const dirs = familyDirectories(root);
  const blockers: string[] = [], notes: string[] = [];
  const keep = new Map<string, string[]>(), ambiguous = new Map<string, string[]>();
  const blocked = new Map<GenerationFamily, string>();
  const key = (family: GenerationFamily, name: string) => `${family}\0${name}`;
  const add = (map: Map<string, string[]>, family: GenerationFamily, name: string, reason: string) => {
    const k = key(family, name), list = map.get(k) ?? [];
    if (!list.includes(reason)) list.push(reason);
    map.set(k, list);
  };
  const ref = (family: GenerationFamily, name: string | null | undefined, reason: string) => { if (name) add(keep, family, name, reason); };
  const kept = (family: GenerationFamily, name: string) => keep.has(key(family, name));
  const retained = (family: GenerationFamily, name: string) => kept(family, name) || ambiguous.has(key(family, name));
  const block = (families: GenerationFamily[], reason: string) => { for (const family of families) if (!blocked.has(family)) blocked.set(family, reason); };
  /** `<familyDir>/<name>` tokens inside arbitrary text (paths in receipts, command lines). */
  const pathRefs = (family: GenerationFamily, text: string): string[] => {
    return pathReferences(dirs[family], text);
  };
  const hexRefs = (text: string): Set<string> => new Set(text.match(/[a-f0-9]{64}/g) ?? []);
  const DOCTOR_FAMILIES: GenerationFamily[] = ["doctor-jobs", "doctor-analysis-checkpoints", "doctor-maintenance", "doctor-implementation-acceptance"];
  const MANAGER_FAMILIES: GenerationFamily[] = ["manager-generations", "manager-runtime-generations", "manager-managed-runtime-generations"];
  const VARIANT_FAMILIES: GenerationFamily[] = ["variant-previous", "variant-builds"];

  // Committed children remain dependencies after original operation settlement
  // and after both workers leave CURRENT/PREVIOUS. Never infer retirement from
  // phase labels or discover replacement authority by mtime.
  const repairHeads=join(root,"transactions","manager-recovery-bindings");
  try {
    let names:string[]=[];
    try {names=readdirSync(repairHeads).sort();}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    for(const name of names.filter(name=>name.endsWith(".runtime-repair-head.json"))){
      try {
        if(!UUID.test(name.slice(0,-".runtime-repair-head.json".length)))throw new Error("invalid fixed head filename");
        const references=runtimeRepairRetentionReferences(root,join(repairHeads,name));
        for(const family of GENERATION_FAMILIES)for(const generation of pathRefs(family,JSON.stringify(references)))ref(family,generation,`retained accepted runtime repair ${name}`);
      }catch(error){block([...MANAGER_FAMILIES,...VARIANT_FAMILIES,"doctor-jobs"],`Accepted runtime repair ${name} proof is unreadable: ${message(error)}`);}
    }
  }catch(error){block([...MANAGER_FAMILIES,...VARIANT_FAMILIES,"doctor-jobs"],`Accepted runtime repair head inventory is unreadable: ${message(error)}`);}

  // A native handoff authenticates old failed histories on every later update.
  // Its issuing worker and retained receipts survive ordinary phase settlement.
  const nativeReplacements = join(root, "transactions", "native-replacements");
  try {
    let names: string[] = [];
    let present = false;
    try { lstatSync(nativeReplacements); present = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (present) {
      const stat = lstatSync(nativeReplacements);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || realpathSync(nativeReplacements) !== nativeReplacements) throw new Error("unsafe fixed inventory directory");
      names = readdirSync(nativeReplacements).sort();
    }
    for (const name of names) {
      try {
        const references = nativeReplacementRetentionReferences(root, name);
        for (const family of GENERATION_FAMILIES) for (const generation of pathRefs(family, JSON.stringify(references))) ref(family, generation, `retained native replacement ${name}`);
      } catch (error) { block([...MANAGER_FAMILIES, ...VARIANT_FAMILIES, "doctor-jobs"], `Native replacement ${name} proof is unreadable: ${message(error)}`); }
    }
  } catch (error) { block([...MANAGER_FAMILIES, ...VARIANT_FAMILIES, "doctor-jobs"], `Native replacement inventory is unreadable: ${message(error)}`); }

  // Operation recovery references must be collected before either dependency
  // closure. A stale label is not a live consumer; unresolved exact bindings
  // are recovery material, while legacy ambiguity blocks its known paths.
  const operationRoot = join(root, "transactions", "manager-operations");
  for (const name of listDir(operationRoot)) {
    if (!name.endsWith(".json")) continue;
    const read = readJson(join(operationRoot, name), 64 * 1024);
    if (read.state !== "ok") { block(MANAGER_FAMILIES, `Manager operation ${name} is unreadable`); continue; }
    let record;
    try { record = parsePreparedOperation(read.value, name.slice(0, -5)); }
    catch { block(MANAGER_FAMILIES, `Manager operation ${name} is malformed`); continue; }
    if (!["prepared", "consumed", "recovery-required"].includes(record.phase)) continue;
    let binding;
    try { binding = readManagerRecoveryBinding(root, record.operationId); }
    catch { block([...MANAGER_FAMILIES, ...VARIANT_FAMILIES, "doctor-jobs"], `Operation ${record.operationId} recovery binding is unreadable`); continue; }
    if (binding && managerOperationRecoveryIsVerified(root, record.operationId, { expectedReceiptRefs: record.receiptRefs, consumedAt: record.consumedAt ?? undefined })) continue;
    if (!binding && managerOperationHasSafePrepublicationFailure(record)) continue;
    const reason = `Manager operation ${record.operationId} (${record.phase})`;
    const text = JSON.stringify({ moduleIdentity: record.moduleIdentity, receiptRefs: record.receiptRefs });
    for (const family of GENERATION_FAMILIES) for (const generation of pathRefs(family, text)) {
      if (record.phase === "recovery-required" && !binding) add(ambiguous, family, generation, `${reason}: exact recovery evidence is absent`);
      else ref(family, generation, reason);
    }
    if (binding) {
      ref("variant-previous", binding.promotionId, `${reason}: exact rollback generation`);
      ref("variant-builds", binding.promotionId, `${reason}: exact staged generation`);
      const references = JSON.stringify([...binding.dependencyPaths, ...binding.receiptRefs]);
      for (const family of GENERATION_FAMILIES) for (const generation of pathRefs(family, references)) ref(family, generation, `${reason}: bound dependency`);
      const journal = readJson(binding.journal.path, 64 * 1024);
      if (journal.state === "ok") for (const family of GENERATION_FAMILIES) for (const generation of pathRefs(family, journal.text)) ref(family, generation, `${reason}: bound journal dependency`);
      else block([...VARIANT_FAMILIES, "doctor-jobs"], `${reason}: exact journal is unreadable`);
    } else if (record.phase === "recovery-required") {
      // There is no authority to classify an unbound legacy promotion as
      // restored. Limit ambiguity to installation/recovery families.
      block(VARIANT_FAMILIES, `${reason}: no exact promotion binding`);
    }
  }

  // Locks: an owner in progress means references may be mid-change.
  if (!options.locksOwnedByCaller) {
    try { if (isLifecycleLockHeld(root)) blockers.push("A Tweakers lifecycle operation holds the lifecycle lock"); }
    catch (error) { blockers.push(`Lifecycle lock state is unreadable: ${message(error)}`); }
    const promotionLock = join(root, "variants", "tweakers", "transactions", "variant-promotion.lock");
    try { if (isLockHeldByLiveOwner(promotionLock)) blockers.push("A variant promotion holds its transaction lock"); }
    catch (error) { blockers.push(`Variant promotion lock state is unreadable: ${message(error)}`); }
    const sourceLock = join(root, "official-source", "official-source.lock");
    try { if (isLockHeldByLiveOwner(sourceLock)) block(["official-source-baselines"], "Official-source registration lock is held"); }
    catch (error) { block(["official-source-baselines"], `Official-source lock is unreadable: ${message(error)}`); }
  }
  try {
    const operation = readLocalOperation(join(root, "local-operation"));
    if (operation?.state === "running" && operation.processStartedAt && processIdentityAlive(operation.pid, operation.processStartedAt)
      && !options.locksOwnedByCaller) notes.push(`Local operation "${operation.kind}" is running; apply waits for its lease`);
  } catch (error) { notes.push(`Local operation record is unreadable: ${message(error)}`); }

  // Running processes are active dependencies of any family.
  const commands = (options.processCommands ?? defaultProcessCommands)();
  for (const family of GENERATION_FAMILIES) for (const command of commands) for (const name of pathRefs(family, command)) ref(family, name, "running process references this path");

  // Local artifact reservations that are not retired pin their payloads.
  const reservations = readJson(join(root, "local-artifact-reservations.json"));
  if (reservations.state === "invalid") block([...DOCTOR_FAMILIES, ...VARIANT_FAMILIES, "official-source-baselines"], `local-artifact-reservations.json is unreadable (${reservations.error})`);
  else if (reservations.state === "ok") {
    const rows = Array.isArray(reservations.value.reservations) ? reservations.value.reservations as Array<Record<string, unknown>> : null;
    if (!rows) block([...DOCTOR_FAMILIES, ...VARIANT_FAMILIES], "local-artifact-reservations.json has no reservation list");
    else for (const row of rows) {
      if (row.state === "retired") continue;
      const text = JSON.stringify(row.paths ?? []);
      for (const family of GENERATION_FAMILIES) for (const name of pathRefs(family, text)) ref(family, name, `active local artifact reservation ${String(row.id)}`);
    }
  }

  // Installed and rollback apps, pending promotion transactions.
  const variant = join(root, "variants", "tweakers"), promotions = join(variant, "transactions", "variant-promotion");
  const liveRuntimeTexts: string[] = [];
  const variantHasGenerations = listDir(dirs["variant-previous"]).length > 0 || listDir(dirs["variant-builds"]).length > 0;
  const active = readJson(join(promotions, "active.json"));
  const blockInstallation = (reason: string) => block([...VARIANT_FAMILIES, "doctor-jobs"], reason);
  const doctorJobOfCandidate = (candidate: unknown, reason: string) => {
    const path = str(candidate);
    if (path) for (const name of pathRefs("doctor-jobs", path)) ref("doctor-jobs", name, reason);
  };
  if (active.state === "invalid") blockInstallation(`Installed promotion receipt is unreadable (${active.error})`);
  else if (active.state === "missing") { if (variantHasGenerations) blockInstallation("Installed promotion receipt is missing while generations exist"); }
  else {
    const activeId = str(active.value.id);
    if (!activeId || !UUID.test(activeId)) blockInstallation("Installed promotion receipt has no valid id");
    else {
      ref("variant-previous", activeId, "current promotion (installed app)");
      ref("variant-builds", activeId, "current promotion (installed app)");
      const journal = readJson(join(promotions, `${activeId}.json`));
      if (journal.state !== "ok") blockInstallation(`Installed promotion journal is ${journal.state === "missing" ? "missing" : "unreadable"}`);
      else {
        doctorJobOfCandidate(journal.value.candidate, "installed app candidate packet");
        const receipt = readJson(join(dirs["variant-previous"], activeId, "active-receipt.json"));
        const hadPrior = (journal.value.activeReceipt as { hadDestination?: unknown } | undefined)?.hadDestination === true;
        if (receipt.state === "invalid") blockInstallation(`Rollback receipt is unreadable (${receipt.error})`);
        else if (receipt.state === "missing") { if (hadPrior) blockInstallation("Rollback receipt is missing although the installed promotion replaced a prior receipt"); }
        else {
          const rollbackId = str(receipt.value.id);
          if (!rollbackId || !UUID.test(rollbackId)) blockInstallation("Rollback receipt has no valid id");
          else {
            ref("variant-previous", rollbackId, "rollback promotion (previous installed app)");
            ref("variant-builds", rollbackId, "rollback promotion (previous installed app)");
            const rollbackJournal = readJson(join(promotions, `${rollbackId}.json`));
            if (rollbackJournal.state === "ok") doctorJobOfCandidate(rollbackJournal.value.candidate, "rollback app candidate packet");
            else block(["doctor-jobs"], `Rollback promotion journal is ${rollbackJournal.state === "missing" ? "missing" : "unreadable"}; its candidate packet is unknown`);
          }
        }
      }
      liveRuntimeTexts.push(...topLevelJsonTexts(join(variant, "runtime")));
      liveRuntimeTexts.push(...topLevelJsonTexts(join(dirs["variant-previous"], activeId, "state", "runtime")));
    }
  }
  for (const name of listDir(promotions)) {
    if (!name.endsWith(".json") || name === "active.json") continue;
    const id = name.slice(0, -5), journal = readJson(join(promotions, name));
    if (journal.state !== "ok") { block([...VARIANT_FAMILIES, "doctor-jobs"], `Promotion journal ${name} is unreadable`); continue; }
    if (["committed", "recovered"].includes(String(journal.value.phase))) continue;
    ref("variant-previous", id, `pending promotion transaction (${String(journal.value.phase)})`);
    ref("variant-builds", id, `pending promotion transaction (${String(journal.value.phase)})`);
    doctorJobOfCandidate(journal.value.candidate, "pending promotion candidate packet");
  }
  for (const text of liveRuntimeTexts) {
    for (const name of pathRefs("doctor-jobs", text)) ref("doctor-jobs", name, "installed/rollback runtime recovery reference");
    for (const hex of hexRefs(text)) {
      ref("manager-runtime-generations", hex, "installed/rollback runtime reference");
      ref("manager-managed-runtime-generations", hex, "installed/rollback runtime reference");
    }
  }

  // Registered official source (installed version) and its baseline.
  let installedBaseline: string | null = null;
  const evidence = readJson(join(root, "official-source", "current-evidence.json"));
  if (evidence.state === "invalid") block(["doctor-jobs", "official-source-baselines"], `Registered official-source evidence is unreadable (${evidence.error})`);
  else if (evidence.state === "ok") {
    for (const name of pathRefs("doctor-jobs", evidence.text)) ref("doctor-jobs", name, "registered official source (installed version)");
    installedBaseline = str(evidence.value.baselinePath);
    for (const name of pathRefs("official-source-baselines", evidence.text)) ref("official-source-baselines", name, "registered official source baseline (installed version)");
    for (const hex of hexRefs(evidence.text)) ref("manager-generations", hex, "registered official-source evidence");
  }
  for (const pointer of [join(root, "official-source", "current.json"), join(root, "transactions", "official-source-registration.json"), join(root, "direct-official-update.json")]) {
    const read = readJson(pointer);
    if (read.state === "invalid") { block(["doctor-jobs", "official-source-baselines"], `${basename(pointer)} is unreadable`); continue; }
    if (read.state !== "ok") continue;
    if (basename(pointer) === "official-source-registration.json" && read.value.phase === "completed") continue;
    for (const name of pathRefs("doctor-jobs", read.text)) ref("doctor-jobs", name, `${basename(pointer)} reference`);
    for (const name of pathRefs("official-source-baselines", read.text)) ref("official-source-baselines", name, `${basename(pointer)} reference`);
  }
  for (const name of listDir(join(root, "failed-official-sources"))) {
    const read = readJson(join(root, "failed-official-sources", name));
    if (read.state !== "ok") { block(["doctor-jobs"], `Failed-source journal ${name} is unreadable`); continue; }
    if (read.value.phase !== "reconciled") for (const job of pathRefs("doctor-jobs", read.text)) ref("doctor-jobs", job, "unreconciled failed-source journal");
  }

  // Doctor: current + previous job, live workers, in-progress checks.
  const doctor = join(root, "doctor");
  const update = readJson(join(doctor, "update.json"));
  let currentJob: Record<string, unknown> | null = null;
  if (update.state === "invalid") block([...DOCTOR_FAMILIES, "official-source-baselines"], `doctor/update.json is unreadable (${update.error})`);
  else if (update.state === "ok") {
    currentJob = update.value;
    ref("doctor-jobs", str(update.value.id), "current Doctor job (doctor/update.json)");
    ref("doctor-jobs", str(update.value.predecessorId), "previous Doctor job (predecessor of current)");
  }
  const operation = readJson(join(doctor, "update-operation.json"));
  if (operation.state === "ok") ref("doctor-jobs", str(operation.value.jobId), "doctor/update-operation.json");
  const liveWorkers = new Set<string>();
  for (const name of listDir(doctor)) {
    const id = /^worker-([a-f0-9-]{36})\.lock(?:\.claims)?$/.exec(name)?.[1];
    if (!id || liveWorkers.has(id)) continue;
    try { if (isLockHeldByLiveOwner(join(doctor, `worker-${id}.lock`))) { liveWorkers.add(id); ref("doctor-jobs", id, "live Doctor worker lock"); } }
    catch (error) { add(ambiguous, "doctor-jobs", id, `worker lock unreadable: ${message(error)}`); }
  }
  const jobRecords = new Map<string, Record<string, unknown>>();
  for (const name of listDir(dirs["doctor-jobs"])) {
    const read = readJson(join(dirs["doctor-jobs"], name, "job.json"), 128 * 1024 * 1024);
    if (read.state === "invalid") { add(ambiguous, "doctor-jobs", name, `job.json unreadable (${read.error})`); continue; }
    if (read.state !== "ok") continue;
    jobRecords.set(name, read.value);
    const state = (read.value.result as { state?: unknown } | undefined)?.state;
    if (state === "checking") {
      if (liveWorkers.has(name)) ref("doctor-jobs", name, "Doctor job is checking with a live worker");
      else {
        // A supersession receipt plus a definitely exited worker identifies a
        // historical interrupted check. All other active references still pin it.
        const successor = str(read.value.supersededBy);
        const pid = read.value.pid;
        let exited = false;
        if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (error) { exited = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        }
        if (!(successor && successor !== name && UUID.test(successor) && exited)) {
          add(ambiguous, "doctor-jobs", name, "job state is 'checking' without a live worker lock (stale in-progress record)");
        }
      }
    }
  }
  // Kept jobs pin what they point at (never the predecessor chain itself).
  const jobReferenceText = (record: Record<string, unknown>) => JSON.stringify({ ...record, predecessorId: undefined, lastCompletedResult: undefined });
  const scanned = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const name of listDir(dirs["doctor-jobs"])) {
      if (!retained("doctor-jobs", name) || scanned.has(name)) continue;
      scanned.add(name); changed = true;
      const records = [name === str(currentJob?.id) ? currentJob : null, jobRecords.get(name) ?? null].filter((row): row is Record<string, unknown> => row !== null);
      const texts = [...records.map(jobReferenceText), ...topLevelJsonTexts(join(dirs["doctor-jobs"], name)).filter(text => !text.includes("\"predecessorId\""))];
      for (const text of texts) {
        for (const job of pathRefs("doctor-jobs", text)) if (job !== name) ref("doctor-jobs", job, `referenced by kept Doctor job ${name}`);
        for (const baseline of pathRefs("official-source-baselines", text)) ref("official-source-baselines", baseline, `referenced by kept Doctor job ${name}`);
        for (const hex of hexRefs(text)) {
          ref("manager-generations", hex, `referenced by kept Doctor job ${name}`);
          ref("manager-runtime-generations", hex, `referenced by kept Doctor job ${name}`);
          ref("manager-managed-runtime-generations", hex, `referenced by kept Doctor job ${name}`);
        }
        for (const family of ["doctor-analysis-checkpoints", "doctor-maintenance", "doctor-implementation-acceptance"] as const) {
          for (const entry of pathRefs(family, text)) ref(family, entry, `referenced by kept Doctor job ${name}`);
          for (const entry of listDir(dirs[family])) if (HEX64.test(entry) || UUID.test(entry)) { if (text.includes(entry)) ref(family, entry, `named by kept Doctor job ${name}`); }
        }
      }
    }
  }
  const keptJobIds = [...scanned];
  for (const family of ["doctor-maintenance", "doctor-implementation-acceptance"] as const) {
    for (const entry of listDir(dirs[family])) {
      if (keptJobIds.includes(entry)) ref(family, entry, "belongs to a kept Doctor job");
      for (const text of topLevelJsonTexts(join(dirs[family], entry), 32)) for (const job of keptJobIds) if (text.includes(job)) ref(family, entry, `ties to kept Doctor job ${job}`);
    }
  }
  // Baselines: current Doctor job, installed version, and the previous one.
  const currentBaseline = str(currentJob?.baselinePath);
  if (currentBaseline) for (const name of pathRefs("official-source-baselines", currentBaseline)) ref("official-source-baselines", name, "current Doctor job baseline");
  if (installedBaseline) for (const name of pathRefs("official-source-baselines", installedBaseline)) ref("official-source-baselines", name, "installed version baseline");
  {
    const newest = currentBaseline ?? installedBaseline;
    let cursor = str(currentJob?.predecessorId), found = false;
    for (let hops = 0; cursor && hops < 200 && !found; hops++) {
      const record = jobRecords.get(cursor);
      if (!record) { notes.push(`Previous baseline search stopped at Doctor job ${cursor} (no readable job.json)`); break; }
      const baseline = str(record.baselinePath);
      if (baseline && baseline !== newest) {
        for (const name of pathRefs("official-source-baselines", baseline)) { ref("official-source-baselines", name, "previous baseline (Doctor predecessor chain)"); found = true; }
      }
      cursor = str(record.predecessorId);
    }
  }

  // Manager generations: current + previous from the record and descriptor.
  const managerRoot = join(root, "managers", TWEAKERS_MANAGER_ID);
  const hasManager = listDir(dirs["manager-generations"]).length > 0;
  if (hasManager) {
    const record = readJson(join(managerRoot, "previous-generation.json"), 64 * 1024);
    if (record.state !== "ok") block(MANAGER_FAMILIES, `previous-generation.json is ${record.state === "missing" ? "missing" : `unreadable (${record.error})`}`);
    else {
      const identities: Array<[string, unknown]> = [["current", record.value.current], ["previous", record.value.previous]];
      if (record.value.version !== 1 || !record.value.current || record.value.previous === undefined) block(MANAGER_FAMILIES, "previous-generation.json has an unsupported shape");
      for (const [label, identity] of identities) {
        if (identity === null) continue;
        const row = identity as Record<string, unknown> | undefined;
        const fields = ["generationId", "runtimeFingerprint", "managedRuntimeFingerprint"].map(field => str(row?.[field]));
        if (fields.some(value => !value || !HEX64.test(value))) { block(MANAGER_FAMILIES, `previous-generation.json ${label} identity is invalid`); continue; }
        ref("manager-generations", fields[0], `${label} Manager generation (previous-generation.json)`);
        ref("manager-runtime-generations", fields[1], `${label} Manager generation runtime (previous-generation.json)`);
        ref("manager-managed-runtime-generations", fields[2], `${label} Manager generation managed runtime (previous-generation.json)`);
      }
    }
    let descriptorFile: string | null = null;
    try { descriptorFile = tweakersManagerDescriptorPaths(root, options.descriptorRoot).descriptorFile; }
    catch (error) { block(MANAGER_FAMILIES, `Manager descriptor path is unavailable: ${message(error)}`); }
    if (descriptorFile) {
      const descriptor = readJson(descriptorFile, 16 * 1024);
      if (descriptor.state !== "ok") block(MANAGER_FAMILIES, `Manager descriptor is ${descriptor.state === "missing" ? "missing" : "unreadable"}`);
      else {
        const executable = str(descriptor.value.executable);
        const generation = executable ? dirname(executable) : null;
        if (!generation || dirname(generation) !== dirs["manager-generations"]) block(MANAGER_FAMILIES, "Manager descriptor target is outside managed generations");
        else ref("manager-generations", basename(generation), "Manager descriptor target");
      }
    }
    // Dependency closure of every kept generation.
    for (const generation of listDir(dirs["manager-generations"])) {
      if (!retained("manager-generations", generation) || !HEX64.test(generation)) continue;
      try {
        const bindings = readTweakersManagerGenerationBindings(join(dirs["manager-generations"], generation));
        ref("manager-runtime-generations", bindings.runtimeFingerprint, `runtime of kept Manager generation ${generation.slice(0, 12)}`);
        ref("manager-managed-runtime-generations", bindings.managedRuntimeFingerprint, `managed runtime of kept Manager generation ${generation.slice(0, 12)}`);
      } catch (error) {
        block(["manager-runtime-generations", "manager-managed-runtime-generations"], `Kept Manager generation ${generation} bindings are unreadable (${message(error)})`);
      }
    }
  }

  // Inventory.
  const entries: GenerationRetentionEntry[] = [];
  const families = {} as Record<GenerationFamily, GenerationFamilySummary>;
  for (const family of GENERATION_FAMILIES) {
    const summary: GenerationFamilySummary = { directory: dirs[family], blocked: blocked.get(family) ?? null,
      keep: { count: 0, bytes: 0 }, retire: { count: 0, bytes: 0 }, ambiguous: { count: 0, bytes: 0 } };
    families[family] = summary;
    for (const name of listDir(dirs[family])) {
      const path = join(dirs[family], name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      const reasons = [...(keep.get(key(family, name)) ?? [])];
      let decision: GenerationDecision = reasons.length ? "keep" : "retire";
      const doubt = [...(ambiguous.get(key(family, name)) ?? [])];
      if (name.startsWith(".")) doubt.push("hidden or in-progress staging entry");
      else if (!expectedName(family, name)) doubt.push("unrecognized entry name");
      if (stat.isSymbolicLink() || !stat.isDirectory()) doubt.push("not a real directory");
      if (decision === "retire" && summary.blocked) doubt.push(`family blocked: ${summary.blocked}`);
      if (doubt.length) { reasons.push(...doubt); if (decision === "retire") decision = "ambiguous"; }
      if (decision === "retire") reasons.push("not current, previous, or referenced by any active consumer");
      const bytes = options.includeSizes === false ? 0 : measureBytes(path);
      entries.push({ family, name, path, bytes, mtimeMs: stat.mtimeMs, identity: { dev: stat.dev, ino: stat.ino }, decision, reasons });
      summary[decision].count++; summary[decision].bytes += bytes;
    }
    if (summary.blocked) notes.push(`${family}: retained entirely — ${summary.blocked}`);
  }
  return { version: 1, kind: "tweakers-generation-retention-plan", root, createdAt: new Date().toISOString(), blockers, notes, families, entries };
}

async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const sameSeal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function recoverableTrash(root: string): string {
  if (!existsSync(root) || realpathSync(root) !== resolve(root) || !lstatSync(root).isDirectory()) throw new Error("Recoverable Trash is unavailable; local original retained");
  return root;
}

/**
 * Retire exactly the entries a fresh plan still classifies as retirable, under
 * the local operation lease, the lifecycle lock, and the promotion/source
 * locks. Archive copies are verified by size and tree seal before the local
 * original moves intact to recoverable Trash; without the archive, a Trash
 * move is used only when policy allows. Trash is never emptied.
 */
export async function applyGenerationRetention(root: string, plan: GenerationRetentionPlan, options: ApplyGenerationRetentionOptions = {}): Promise<GenerationRetentionResult> {
  if (plan?.version !== 1 || plan.kind !== "tweakers-generation-retention-plan" || plan.root !== root) throw new Error("Generation retention plan does not match this root");
  if (plan.blockers.length) throw new Error(`Generation retention is blocked: ${plan.blockers.join("; ")}`);
  return withLocalOperation("generation retention", () => withLifecycleLock(lifecycleLockFile(root), "generation retention", async () => {
    const releases: Array<() => void> = [];
    const hold = (lockFile: string, label: string) => {
      if (!existsSync(dirname(lockFile)) || readLockOwner(lockFile) === process.pid) return;
      const lock = acquireProcessLock(lockFile, { onContended: () => new Error(`${label} is in progress; generation retention deferred`) });
      releases.push(() => lock.release());
    };
    try {
      hold(join(root, "variants", "tweakers", "transactions", "variant-promotion.lock"), "A variant promotion");
      hold(join(root, "official-source", "official-source.lock"), "Official-source registration");
      const fresh = planGenerationRetention(root, { ...options, locksOwnedByCaller: true });
      if (fresh.blockers.length) throw new Error(`Generation retention is blocked: ${fresh.blockers.join("; ")}`);
      const result: GenerationRetentionResult = { planCreatedAt: plan.createdAt, retired: [], skipped: [] };
      const current = new Map(fresh.entries.map(entry => [entry.path, entry]));
      const queue: GenerationRetentionEntry[] = [];
      for (const planned of plan.entries.filter(entry => entry.decision === "retire")) {
        const now = current.get(planned.path);
        if (!now) { result.skipped.push({ ...pick(planned), reason: "entry no longer exists" }); continue; }
        if (now.decision !== "retire") { result.skipped.push({ ...pick(planned), reason: `now ${now.decision}: ${now.reasons.join("; ")}` }); continue; }
        if (now.identity?.dev !== planned.identity?.dev || now.identity?.ino !== planned.identity?.ino) { result.skipped.push({ ...pick(planned), reason: "filesystem identity changed since planning" }); continue; }
        queue.push(now);
      }
      queue.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
      const policy = readArtifactRetentionPolicy(root);
      let archiveError: string | null = null;
      if (policy.retireTo === "archive") {
        try { (options.assertArchive ?? assertArchiveVolume)(policy.archiveVolume, policy.archiveVolumeUUID); }
        catch (error) { archiveError = message(error); }
      }
      if (archiveError && !policy.allowTrashFallback) throw new Error(`Archive volume is unavailable and Trash fallback is disabled: ${archiveError}`);
      const archiveRoot = options.archiveRoot ?? join(policy.archiveVolume, "_Mac-Archive", "Tweakers", "retired-generations");
      const trashRoot = options.trashRoot ?? join(targetUserHome() || homedir(), ".Trash");
      let spent = 0;
      for (const entry of queue) {
        if (options.maxBytes !== undefined && spent > 0 && spent + entry.bytes > options.maxBytes) {
          result.skipped.push({ ...pick(entry), reason: "deferred by this run's byte budget" }); continue;
        }
        try {
          const retired = await retireEntry(root, entry, plan.createdAt, policy.retireTo === "archive" && archiveError === null ? { kind: "archive", root: archiveRoot, trashRoot, volume: options.archiveRoot ?? policy.archiveVolume, volumeUUID: policy.archiveVolumeUUID } : { kind: "trash", root: trashRoot, reason: archiveError ?? "Trash retention policy" }, () => {
            const latest = planGenerationRetention(root, { ...options, locksOwnedByCaller: true });
            const eligible = latest.entries.find(item => item.path === entry.path);
            if (latest.blockers.length || !eligible || eligible.decision !== "retire"
              || eligible.identity?.dev !== entry.identity?.dev || eligible.identity?.ino !== entry.identity?.ino) {
              throw new Error(`Artifact retirement eligibility changed; local original retained: ${latest.blockers.join("; ") || eligible?.reasons.join("; ") || "entry missing"}`);
            }
            // Retain the full dependency graph (a manager/Doctor process can
            // pin a runtime indirectly), but omit expensive directory sizing.
            return () => {
              const last = planGenerationRetention(root, { ...options, locksOwnedByCaller: true, includeSizes: false });
              const candidate = last.entries.find(item => item.path === entry.path);
              if (last.blockers.length || !candidate || candidate.decision !== "retire"
                || candidate.identity?.dev !== entry.identity?.dev || candidate.identity?.ino !== entry.identity?.ino) {
                throw new Error("Artifact gained a consumer or changed eligibility; local original retained");
              }
            };
          });
          result.retired.push(retired); spent += entry.bytes;
        } catch (error) { result.skipped.push({ ...pick(entry), reason: message(error) }); }
      }
      return result;
    } finally { for (const release of releases.reverse()) release(); }
  }), undefined, undefined, options.wait === false ? { wait: false } : {});
}
const pick = (entry: GenerationRetentionEntry) => ({ family: entry.family, name: entry.name, path: entry.path });

/** Hash metadata without exporting its potentially sensitive values to receipts. */
function metadataSeal(root: string): string | null {
  if (process.platform !== "darwin") return null;
  const hash = createHash("sha256");
  // macOS regenerates provenance/access bookkeeping, and compression is only
  // a storage representation. Reuse the rollback verifier's semantic metadata.
  hash.update(restorationMetadata(root));
  const paths: string[] = [];
  const visit = (path: string) => {
    paths.push(path);
    if (lstatSync(path).isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root);
  for (const path of paths) {
    const stat = lstatSync(path, { bigint: true });
    hash.update(JSON.stringify([path.slice(root.length), String(stat.mode), String(stat.uid), String(stat.gid), String(stat.mtimeNs)]));
  }
  return hash.digest("hex");
}

function verifyRestoration(archive: string, name: string, seal: ReturnType<typeof sealHistoricalArtifactTree>, metadata: string | null, trashRoot: string): void {
  const scratch = mkdtempSync(join(tmpdir(), "tweakers-archive-proof-"));
  let mounted = false;
  let attachmentUncertain = false;
  const mount = join(scratch, "restore");
  try {
    const free = statfsSync(scratch);
    const required = Number(seal.bytes) * 1.5 + 256 * 1024 ** 2;
    if (Number(free.bavail) * Number(free.bsize) < required + 20 * 1024 ** 3) throw new Error("Archive restoration lacks local capacity and 20 GiB reserve");
    mkdirSync(mount);
    if (process.platform === "darwin") {
      const image = join(scratch, "proof.sparseimage");
      execFileSync("/usr/bin/hdiutil", ["create", "-quiet", "-size", `${Math.max(256, Math.ceil(required / 1024 ** 2))}m`, "-fs", "APFS", "-type", "SPARSE", image], { timeout: 60_000, stdio: "pipe" });
      attachmentUncertain = true;
      execFileSync("/usr/sbin/diskutil", ["image", "attach", "--nobrowse", "--mountOptions", "noexec,nosuid,owners", "--mountPoint", mount, image], { timeout: 60_000, stdio: "pipe" });
      mounted = true;
      attachmentUncertain = false;
      const mounts = execFileSync("/sbin/mount", { encoding: "utf8" });
      if (!mounts.split("\n").some(line => line.includes(` on ${realpathSync(mount)} (`) && /[,(] noexec[,)]/.test(line))) throw new Error("Restoration filesystem is not proven non-executable");
    }
    const env = { ...process.env };
    delete env.COPYFILE_DISABLE;
    execFileSync("/usr/bin/tar", ["-xpf", archive, ...(process.platform === "darwin" ? ["--mac-metadata", "--acls", "--xattrs"] : []), "-C", mount],
      { env, timeout: 60 * 60_000, stdio: "pipe" });
    const restored = join(mount, name);
    if (!sameSeal(sealHistoricalArtifactTree(restored), seal)) throw new Error("Restored archive tree differs from the source");
    if (metadataSeal(restored) !== metadata) throw new Error("Restored archive metadata differs from the source");
  } finally {
    if (mounted) {
      // Never force-unmount an occupied proof. Preserve it for recovery on failure.
      execFileSync("/usr/bin/hdiutil", ["detach", "-quiet", mount], { timeout: 60_000, stdio: "pipe" });
    }
    if (attachmentUncertain) throw new Error(`Archive proof attachment was inconclusive; preserved ${scratch} for recovery`);
    // The detached proof is disposable, but it must enter actual Trash before
    // any later permanent disposal. Never remove it if Trash is unavailable.
    renameSync(scratch, join(recoverableTrash(trashRoot), `Tweakers-archive-proof-${randomUUID()}`));
  }
}

type RetireTarget = { kind: "archive"; root: string; trashRoot: string; volume: string; volumeUUID: string | null } | { kind: "trash"; root: string; reason: string };
async function retireEntry(root: string, entry: GenerationRetentionEntry, planCreatedAt: string, target: RetireTarget, recheckEligibility: () => (() => void)): Promise<GenerationRetentionResult["retired"][number]> {
  const stat = lstatSync(entry.path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(entry.path) !== entry.path) throw new Error("Entry is not a real canonical directory");
  if (stat.dev !== entry.identity?.dev || stat.ino !== entry.identity?.ino) throw new Error("Entry identity changed before retirement");
  const id = randomUUID();
  const receipt = join(root, "artifact-archives", "generation-retention", `${id}.json`);
  const seal = sealHistoricalArtifactTree(entry.path);
  const metadata = metadataSeal(entry.path);
  const record: Record<string, unknown> = {
    version: 1, kind: "tweakers-generation-retention", id, family: entry.family, name: entry.name, original: entry.path,
    identity: entry.identity, bytes: entry.bytes, seal, metadataSHA256: metadata, reasons: entry.reasons, planCreatedAt,
    destinationKind: target.kind, destination: null, archiveSHA256: null, phase: "prepared", createdAt: new Date().toISOString(),
    ...(target.kind === "trash" ? { archiveUnavailable: target.reason } : {}),
    restoration: target.kind === "archive"
      ? "Extract the verified pax archive to the original parent under lifecycle ownership (tar --mac-metadata --acls --xattrs -xpf <archive> -C <parent>)"
      : "Move the intact Trash directory back to the original path under lifecycle ownership",
  };
  const publish = () => writeDoctorPrivateJson(receipt, record);
  const revalidate = () => {
    const fresh = lstatSync(entry.path);
    if (fresh.dev !== stat.dev || fresh.ino !== stat.ino || !sameSeal(sealHistoricalArtifactTree(entry.path), seal) || metadataSeal(entry.path) !== metadata) throw new Error("Entry changed during retirement; local original retained");
  };
  publish();
  if (target.kind === "archive") {
    const trash = recoverableTrash(target.trashRoot);
    const directory = join(target.root, entry.family);
    mkdirSync(directory, { recursive: true });
    const free = statfsSync(target.volume);
    if (Number(free.bavail) * Number(free.bsize) < Number(seal.bytes) * 1.2 + 1024 ** 3) throw new Error("Archive volume lacks capacity; local original retained");
    let archive = join(directory, `${entry.name}.tar`);
    if (existsSync(archive)) archive = join(directory, `${entry.name}-${id}.tar`);
    record.destination = archive; record.phase = "archiving"; publish();
    let verified = false;
    try {
      const archiveEnv = { ...process.env };
      delete archiveEnv.COPYFILE_DISABLE;
      execFileSync("/usr/bin/tar", ["--format", "pax", ...(process.platform === "darwin" ? ["--mac-metadata", "--acls", "--xattrs", "--no-read-sparse"] : []), "-cpf", archive, "-C", dirname(entry.path), entry.name],
        { stdio: ["ignore", "ignore", "pipe"], timeout: 6 * 60 * 60_000, env: archiveEnv });
      const archiveSeal = sealArchiveTree(archive, entry.name);
      if (!sameSeal(archiveSeal, seal)) throw new Error("Archive does not reproduce the original tree seal");
      if (lstatSync(archive).size < Number(seal.bytes)) throw new Error("Archive is smaller than the sealed payload");
      verifyRestoration(archive, entry.name, seal, metadata, trash);
      record.restorationVerified = true;
      record.restorationFilesystem = process.platform === "darwin" ? "APFS-noexec" : "local";
      record.archiveSHA256 = await checksum(archive); record.phase = "verified"; publish();
      verified = true;
    } finally {
      // Preserve unverified output for inspection; never permanently delete it.
      if (!verified) { record.phase = "failed"; publish(); }
    }
    if (entry.family === "doctor-jobs") preserveDoctorAdoptionHistory(root, entry.name);
    const recheckProcesses = recheckEligibility();
    revalidate();
    recheckProcesses();
    const localTrashDestination = join(trash, `Tweakers-retired-${entry.family}-${entry.name}-${id}`);
    record.localTrashDestination = localTrashDestination; record.phase = "moving"; publish();
    renameSync(entry.path, localTrashDestination);
    const moved = lstatSync(localTrashDestination);
    if (moved.dev !== stat.dev || moved.ino !== stat.ino) throw new Error("Trash move did not preserve identity; inspect the receipt");
    record.phase = "retired"; record.retiredAt = new Date().toISOString(); publish();
    return { ...pick(entry), bytes: entry.bytes, kind: "archive", destination: archive, receipt };
  }
  const trash = recoverableTrash(target.root);
  const destination = join(trash, `Tweakers-retired-${entry.family}-${entry.name}-${id}`);
  record.destination = destination; record.phase = "moving"; publish();
  if (entry.family === "doctor-jobs") preserveDoctorAdoptionHistory(root, entry.name);
  const recheckProcesses = recheckEligibility();
  revalidate();
  recheckProcesses();
  renameSync(entry.path, destination);
  const moved = lstatSync(destination);
  if (moved.dev !== stat.dev || moved.ino !== stat.ino) throw new Error("Trash move did not preserve identity; inspect the receipt");
  record.phase = "retired"; record.retiredAt = new Date().toISOString(); publish();
  return { ...pick(entry), bytes: entry.bytes, kind: "trash", destination, receipt };
}

/** Aggregate a plan into per-family counts for CLI and receipts. */
export function summarizeGenerationRetentionPlan(plan: GenerationRetentionPlan): Record<string, unknown> {
  const gib = (bytes: number) => Math.round(bytes / 1024 ** 3 * 100) / 100;
  return {
    root: plan.root, createdAt: plan.createdAt, blockers: plan.blockers, notes: plan.notes,
    families: Object.fromEntries(GENERATION_FAMILIES.map(family => {
      const summary = plan.families[family];
      return [family, {
        blocked: summary.blocked,
        keep: { count: summary.keep.count, gib: gib(summary.keep.bytes) },
        retire: { count: summary.retire.count, gib: gib(summary.retire.bytes) },
        ambiguous: plan.entries.filter(entry => entry.family === family && entry.decision === "ambiguous").map(entry => ({ name: entry.name, gib: gib(entry.bytes), reasons: entry.reasons })),
      }];
    })),
  };
}

const TRIGGER_BUDGET_BYTES = 4 * 1024 ** 3;
const TRIGGER_WAIT_MS = 5 * 60_000;
let pendingRun: Promise<void> | null = null;
let rerunRequested = false;

/**
 * Best-effort trigger. It never throws, runs only for the canonical root, and
 * starts outside the caller's lifecycle/operation context so it acquires its
 * own leases after the triggering owner finishes.
 */
export function scheduleGenerationRetention(root: string, reason: string): void {
  try {
    if (process.env.TWEAKERS_TEST_ROOT_PRELOAD === "active" || process.env.TWEAKERS_DISABLE_GENERATION_RETENTION === "1") return;
    if (root !== canonicalTweakersManagerRoot()) return;
    if (pendingRun) { rerunRequested = true; return; }
    outsideLifecycleContext(() => outsideLocalOperationContext(() => {
      pendingRun = new Promise<void>(done => setImmediate(done))
        .then(() => runTriggeredRetention(root, reason))
        .finally(() => {
          pendingRun = null;
          if (rerunRequested) { rerunRequested = false; scheduleGenerationRetention(root, `${reason} (coalesced)`); }
        });
    }));
  } catch { /* Best effort only. */ }
}

async function runTriggeredRetention(root: string, reason: string): Promise<void> {
  try {
    const deadline = Date.now() + TRIGGER_WAIT_MS;
    const busy = () => {
      if (isLifecycleLockHeld(root) || isLockHeldByLiveOwner(join(root, "variants", "tweakers", "transactions", "variant-promotion.lock"))) return true;
      const operation = readLocalOperation(join(root, "local-operation"));
      return operation?.state === "running" && !!operation.processStartedAt && processIdentityAlive(operation.pid, operation.processStartedAt);
    };
    while (busy()) {
      if (Date.now() > deadline) throw new Error("Tweakers stayed busy; retention deferred to the next trigger");
      await new Promise(done => setTimeout(done, 2_000));
    }
    const plan = planGenerationRetention(root);
    if (plan.blockers.length || !plan.entries.some(entry => entry.decision === "retire")) return;
    const result = await applyGenerationRetention(root, plan, { maxBytes: TRIGGER_BUDGET_BYTES, wait: false });
    writeDoctorPrivateJson(join(root, "artifact-archives", "generation-retention", "last-run.json"),
      { version: 1, reason, at: new Date().toISOString(), retired: result.retired.length, skipped: result.skipped.length, bytes: result.retired.reduce((sum, row) => sum + row.bytes, 0) });
  } catch (error) {
    try {
      writeDoctorPrivateJson(join(root, "artifact-archives", "generation-retention", "last-error.json"), { version: 1, reason, error: message(error), at: new Date().toISOString() });
    } catch { /* Best effort only. */ }
    console.warn(`Tweakers generation retention requires attention: ${message(error)}`);
  }
}

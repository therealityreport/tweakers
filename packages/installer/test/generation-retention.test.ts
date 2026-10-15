import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { planGenerationRetention, type GenerationFamily } from "../src/generation-retention.js";
import { createTweakersManagerGenerationId, serializeTweakersManagerTargetSeal } from "../src/manager-descriptor.js";
import { NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1 } from "@therealityreport/tweakers-sdk";
import { ManagerOperationStore } from "../src/manager-operation-store.js";
import { persistManagerRecoveryBinding, type ManagerRecoveryBindingV1 } from "../src/manager-recovery-evidence.js";
import type { TweakersManagerPreparedOperationV1 } from "../src/manager-contract.js";

const managerId = "com.thomashulihan.tweakers";
const operationId = "11111111-1111-4111-8111-111111111111";
const promotionId = "22222222-2222-4222-8222-222222222222";
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
function writeJson(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retention-operation-"))), manager = join(root, "managers", managerId), descriptorRoot = join(root, "descriptors");
  const generation = (seed: string) => {
    const runtimeFingerprint = hex(`runtime:${seed}`), managedRuntimeFingerprint = hex(`managed:${seed}`);
    const bundle = `//# TWEAKERS_MANAGER_RUNTIME_FINGERPRINT_V1=${runtimeFingerprint}\n//# TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT_V1=${managedRuntimeFingerprint}\n`;
    const seal = { managerId, protocolVersion: 1 as const, launcherSha256: hex("launcher"), nodePath: "/usr/local/bin/node", nodeSha256: hex("node"), managerSha256: hex(bundle), managedRuntimeFingerprint } as const;
    const generationId = createTweakersManagerGenerationId(seal), directory = join(manager, "generations", generationId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "manager.mjs"), bundle);
    writeFileSync(join(directory, "target.seal"), serializeTweakersManagerTargetSeal({ ...seal, generationId }));
    writeFileSync(join(directory, "Tweakers Manager Launcher"), "launcher");
    for (const [family, id] of [["runtime-generations", runtimeFingerprint], ["managed-runtime-generations", managedRuntimeFingerprint]]) {
      mkdirSync(join(manager, family!, id!), { recursive: true, mode: 0o700 }); writeFileSync(join(manager, family!, id!, "index.js"), "fixture");
    }
    return { generationId, runtimeFingerprint, managedRuntimeFingerprint, sealSha256: hex(`seal:${seed}`) };
  };
  const current = generation("current"), previous = generation("previous"), old = generation("recovery"), unrelated = generation("unrelated");
  writeJson(join(manager, "previous-generation.json"), { version: 1, current, previous });
  writeJson(join(descriptorRoot, `${managerId}.json`), { executable: join(manager, "generations", current.generationId, "Tweakers Manager Launcher") });
  const operation: TweakersManagerPreparedOperationV1 = {
    schemaVersion: 1, kind: "tweakers-manager-operation", managerId, protocolVersion: 1, operationId, preparedRequestId: promotionId,
    actionId: "refresh.independent", moduleIdentity: { state: "resolved", path: join(manager, "generations", old.generationId, "Tweakers Manager Launcher"), sha256: hex("launcher") },
    boundStateToken: `sha256:${hex("state")}`, parameters: {}, parametersSha256: `sha256:${hex("params")}`, impact: "repair-app",
    createdAt: "2026-10-10T00:00:00.000Z", expiresAt: "2026-10-10T00:05:00.000Z", phase: "recovery-required", consumedAt: "2026-10-10T00:01:00.000Z",
    cancelledAt: null, completedAt: null, failedAt: null, recoveryRequiredAt: "2026-10-10T00:02:00.000Z", stateTokenInputsSha256: `sha256:${hex("inputs")}`,
    receiptChronologyRevision: `sha256:${hex("chronology")}`, receiptSnapshot: [], receiptRefs: ["independent-tweakers-patch:1.0.0"], outcome: "recovery-required", error: "rollback incomplete",
  };
  new ManagerOperationStore(root).create(operation);
  const options = { descriptorRoot, processCommands: () => [], includeSizes: false, locksOwnedByCaller: true };
  const decision = (family: GenerationFamily, name: string) => planGenerationRetention(root, options).entries.find(entry => entry.family === family && entry.name === name)?.decision;
  return { root, manager, current, previous, old, unrelated, options, decision, operation };
}

test("bound recovery pins an older Manager and its full runtime dependency closure", () => {
  const f = fixture();
  try {
    const userRoot = join(f.root, "variants", "tweakers");
    const binding: ManagerRecoveryBindingV1 = { schemaVersion: 1, kind: "tweakers-manager-recovery-binding", operationId, promotionId, userRoot,
      target: "/Applications/Tweakers.app", generation: { appSha256: hex("app"), runtimeFingerprint: hex("runtime"), activeReceiptSha256: hex("receipt") },
      journal: { path: join(userRoot, "transactions", "variant-promotion", `${promotionId}.json`), identitySha256: hex("journal") },
      receiptRefs: f.operation.receiptRefs.slice(), dependencyPaths: [join(f.manager, "runtime-generations", f.old.runtimeFingerprint)], createdAt: "2026-10-10T00:01:01.000Z" };
    persistManagerRecoveryBinding(f.root, binding);
    assert.equal(f.decision("manager-generations", f.old.generationId), "keep");
    assert.equal(f.decision("manager-runtime-generations", f.old.runtimeFingerprint), "keep");
    assert.equal(f.decision("manager-managed-runtime-generations", f.old.managedRuntimeFingerprint), "keep");
    assert.equal(f.decision("manager-generations", f.unrelated.generationId), "retire");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy recovery ambiguity protects known dependencies without pinning all stale generations", () => {
  const f = fixture();
  try {
    assert.equal(f.decision("manager-generations", f.old.generationId), "ambiguous");
    assert.equal(f.decision("manager-runtime-generations", f.old.runtimeFingerprint), "keep");
    assert.equal(f.decision("manager-managed-runtime-generations", f.old.managedRuntimeFingerprint), "keep");
    assert.equal(f.decision("manager-generations", f.unrelated.generationId), "retire");
    assert.equal(f.decision("manager-runtime-generations", f.unrelated.runtimeFingerprint), "retire");
    const plan = planGenerationRetention(f.root, f.options);
    assert.match(plan.families["variant-builds"].blocked ?? "", /no exact promotion binding/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("malformed recovery binding blocks relevant retirement", () => {
  const f = fixture();
  try {
    writeJson(join(f.root, "transactions", "manager-recovery-bindings", `${operationId}.json`), { schemaVersion: 99, operationId });
    const plan = planGenerationRetention(f.root, f.options);
    assert.match(plan.families["manager-generations"].blocked ?? "", /binding is unreadable/);
    assert.equal(plan.entries.some(entry => entry.family.startsWith("manager-") && entry.decision === "retire"), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

import { completeAcceptedRuntimeRepairFixture, completeAcceptedRuntimeRepairSuccessorFixture } from "../../runtime/test/accepted-runtime-repair-fixture.js";
import { produceAcceptedRuntimeRepairChildFixture } from "./fixtures/accepted-runtime-repair-child.js";
import { fingerprintVariantGeneration } from "../src/variant-generation.js";

/** Retention only: fixture bundles do not grant signature or execution authority. */
function retainedNativeReplacementFixture() {
  const f = fixture(), jobId = "33333333-3333-4333-8333-333333333333", replacementId = "44444444-4444-4444-8444-444444444444";
  const root = join(f.root, "transactions", "native-replacements", operationId), launcher = join(f.manager, "generations", f.old.generationId, "Tweakers Manager Launcher");
  const seal = join(dirname(launcher), "target.seal"); chmodSync(launcher, 0o500); chmodSync(seal, 0o600);
  const journal = join(f.root, "variants", "tweakers", "transactions", "variant-promotion", `${promotionId}.json`);
  const binding = join(f.root, "transactions", "manager-recovery-bindings", `${operationId}.json`);
  const bundle = join(f.root, "doctor", "jobs", jobId, "candidate", "receipt", "TweakersCandidateReceipt.bundle");
  writeJson(journal, { id: promotionId, phase: "app:promoted" }); writeJson(binding, { operationId, promotionId });
  writeJson(join(bundle, "Contents", "Resources", "variant-candidate-receipt.json"), { fixture: true });
  const failed = { ...f.operation, phase: "failed", failedAt: "2026-10-10T00:03:00Z", recoveryRequiredAt: null, outcome: "superseded-for-official-bundled-replacement" };
  writeJson(join(f.root, "transactions", "manager-operations", `${operationId}.json`), failed);
  const intent = { version: 1, kind: "tweakers-native-replacement-intent", operationId, promotionId, repairId: null, replacementId,
    createdAt: failed.failedAt, trustedLeafSha1: NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1, originalOperation: f.operation,
    worker: { generationId: f.old.generationId, launcherPath: launcher, launcherSha256: hex(readFileSync(launcher, "utf8")), sealSha256: hex(readFileSync(seal, "utf8")) },
    retained: [journal, binding, bundle].map(path => ({ path, generation: fingerprintVariantGeneration(path) })),
    unchanged: Array.from({ length: 5 }, () => ({ path: journal, generation: fingerprintVariantGeneration(journal) })),
    previousApp: { path: join(f.root, "variants", "tweakers", "previous", promotionId, "app", "Tweakers.app") }, nativeRequest: null };
  const draft = join(root, "intent.json"), signed = join(root, "intent.bundle", "Contents", "Resources", "receipt.json");
  writeJson(draft, intent); writeJson(signed, intent);
  return { ...f, jobId, intent, draft, signed, seal, closure: join(f.manager, "managed-runtime-generations", f.old.managedRuntimeFingerprint), plan: () => planGenerationRetention(f.root, f.options) };
}

test("native replacement retention keeps its displaced issuer and closure after original failure, including before settlement", () => {
  const f = retainedNativeReplacementFixture();
  try {
    const plan = f.plan(); assert.equal(plan.families["manager-generations"].blocked, null);
    for (const [family, name] of [["manager-generations", f.old.generationId], ["manager-runtime-generations", f.old.runtimeFingerprint], ["manager-managed-runtime-generations", f.old.managedRuntimeFingerprint], ["doctor-jobs", f.jobId]] as const) {
      const entry = plan.entries.find(entry => entry.family === family && entry.name === name);
      assert.equal(entry?.decision, "keep"); assert.ok(entry?.reasons.some(reason => reason.includes("native replacement")));
    }
    assert.equal(plan.entries.find(entry => entry.family === "manager-generations" && entry.name === f.unrelated.generationId)?.decision, "retire");
  } finally { disposeRetainedFixture(f.root); }
});

test("native replacement incomplete, changed, linked or missing worker custody blocks affected retirement", () => {
  for (const fault of ["missing-seal", "missing-closure", "changed-draft", "missing-bundle", "public-draft", "linked-inventory"]) {
    const f = retainedNativeReplacementFixture();
    try {
      if (fault === "missing-seal") rmSync(f.seal);
      if (fault === "missing-closure") rmSync(f.closure, { recursive: true });
      if (fault === "changed-draft") writeJson(f.draft, { ...f.intent, replacementId: operationId });
      if (fault === "missing-bundle") rmSync(dirname(dirname(dirname(f.signed))), { recursive: true });
      if (fault === "public-draft") chmodSync(f.draft, 0o644);
      if (fault === "linked-inventory") {
        const inventory = dirname(dirname(f.draft)), external = join(f.root, "external-native-replacements");
        cpSync(inventory, external, { recursive: true }); rmSync(inventory, { recursive: true }); symlinkSync(external, inventory);
      }
      const plan = f.plan(); assert.match(plan.families["manager-generations"].blocked ?? "", /Native replacement/);
      for (const family of ["manager-generations", "manager-runtime-generations", "manager-managed-runtime-generations", "variant-builds", "variant-previous", "doctor-jobs"])
        assert.equal(plan.entries.some(entry => entry.family === family && entry.decision === "retire"), false, fault + ": " + family);
    } finally { disposeRetainedFixture(f.root); }
  }
});

/** Real byte producer and sealed worker fixture. This collector never executes
 * candidate JS or treats its conservative references as signature acceptance. */
function retainedChildFixture(successor=false){
  const f=successor?completeAcceptedRuntimeRepairSuccessorFixture("committed"):completeAcceptedRuntimeRepairFixture("committed"),unrelated=fixture();
  const put=(path:string,value:unknown)=>{writeJson(path,value);return{path,sha256:hex(readFileSync(path,"utf8"))};};
  const read=(path:string)=>JSON.parse(readFileSync(path,"utf8"));
  const jobId="33333333-3333-4333-8333-333333333333",bundle=join(f.managerRoot,"doctor","jobs",jobId,"candidate","receipt","TweakersCandidateReceipt.bundle");
  mkdirSync(dirname(bundle),{recursive:true,mode:0o700});
  const custody=read(f.authority.originals.custody.path);cpSync(custody.originalCandidateReceipt.bundlePath,bundle,{recursive:true});
  custody.originalCandidateReceipt.bundlePath=bundle;
  custody.originalCandidateReceipt.bundleGeneration=fingerprintVariantGeneration(bundle);
  custody.originalCandidateReceipt.json={path:join(bundle,"Contents","Resources","variant-candidate-receipt.json"),sha256:custody.originalCandidateReceipt.json.sha256};
  f.authority.originals.custody=put(f.authority.originals.custody.path,custody);
  const originalSource=read(f.authority.sourceDelta.originalSourceVerification.path);
  originalSource.candidateReceipt=custody.originalCandidateReceipt.json;originalSource.candidateReceiptBundleGeneration=custody.originalCandidateReceipt.bundleGeneration;
  f.authority.sourceDelta.originalSourceVerification=put(f.authority.sourceDelta.originalSourceVerification.path,originalSource);
  if(f.authority.version===2&&"predecessorAuthority" in f) {
    const old=f.predecessorAuthority;
    old.originals.custody=put(old.originals.custody.path,custody);
    const oldSource=read(old.sourceDelta.originalSourceVerification.path);
    oldSource.candidateReceipt=custody.originalCandidateReceipt.json;oldSource.candidateReceiptBundleGeneration=custody.originalCandidateReceipt.bundleGeneration;
    old.sourceDelta.originalSourceVerification=put(old.sourceDelta.originalSourceVerification.path,oldSource);
    const prior=produceAcceptedRuntimeRepairChildFixture({managerRoot:f.managerRoot,userRoot:f.userRoot,authority:old,
      originalJournal:read(old.originals.journal.snapshot.path),originalExpectation:read(old.originals.expectation.snapshot.path),phase:"challenge:published"});
    f.authority.predecessor.binding=prior.runtimeRepair;f.authority.expectedPriorHeadSha256=prior.runtimeRepair.headSha256;
    f.authority.predecessor.publication=put(join(prior.root,"publication.json"),read(join(prior.root,"publication.json")));
    const captured=put(f.authority.predecessor.challenge.snapshot.path,prior.expectation);
    f.authority.predecessor.challenge={...f.authority.predecessor.challenge,snapshot:captured,sourceSha256AtCapture:captured.sha256};
  }
  const journal=read(f.authority.originals.journal.snapshot.path),expectation=read(f.authority.originals.expectation.snapshot.path);
  const child=produceAcceptedRuntimeRepairChildFixture({managerRoot:f.managerRoot,userRoot:f.userRoot,authority:f.authority,originalJournal:journal,originalExpectation:expectation,phase:"committed"});
  // Displace BOTH original and delegated workers from normal CURRENT/PREVIOUS.
  const manager=join(f.managerRoot,"managers",managerId);
  for(const family of ["generations","runtime-generations","managed-runtime-generations"])
    for(const name of readdirSync(join(unrelated.manager,family)))cpSync(join(unrelated.manager,family,name),join(manager,family,name),{recursive:true});
  writeJson(join(manager,"previous-generation.json"),{version:1,current:unrelated.current,previous:unrelated.previous});
  const descriptorRoot=join(f.managerRoot,"descriptors");writeJson(join(descriptorRoot,`${managerId}.json`),{executable:join(manager,"generations",unrelated.current.generationId,"Tweakers Manager Launcher")});
  writeJson(f.originalOperation.path,{...unrelated.operation,operationId:f.input.operationId,phase:"completed",completedAt:"2026-10-12T14:04:00Z",recoveryRequiredAt:null,
    failedAt:null,cancelledAt:null,outcome:"verified-installation-accepted",error:null,moduleIdentity:{state:"resolved",path:f.old.worker.launcherPath,sha256:f.old.worker.launcherSha256},receiptRefs:[]});
  mkdirSync(join(f.userRoot,"previous",f.input.promotionId),{recursive:true,mode:0o700});
  const options={descriptorRoot,processCommands:()=>[],includeSizes:false,locksOwnedByCaller:true};
  const head=join(f.managerRoot,"transactions","manager-recovery-bindings",`${f.input.operationId}.runtime-repair-head.json`);
  return{...f,child,head,options,jobId,unrelated,plan:()=>planGenerationRetention(f.managerRoot,options)};
}
function disposeRetainedFixture(path:string):void{
  const status=lstatSync(path);if(status.isSymbolicLink()){rmSync(path);return;}
  if(status.isDirectory()){chmodSync(path,0o700);for(const name of readdirSync(path))disposeRetainedFixture(join(path,name));}
  rmSync(path,{recursive:true,force:true});
}
test("accepted runtime repair retention keeps both displaced workers and complete closure after original completion",()=>{
  const f=retainedChildFixture();try{
    const plan=f.plan();assert.equal(plan.families["manager-generations"].blocked,null);
    for(const worker of [f.old,f.next])for(const [family,name] of [["manager-generations",worker.worker.generationId],["manager-runtime-generations",worker.baseline.fingerprint],["manager-managed-runtime-generations",worker.managedRoot.split('/').at(-1)!]] as const)
      assert.equal(plan.entries.find(entry=>entry.family===family&&entry.name===name)?.decision,"keep");
    for(const family of ["variant-builds","variant-previous"] as const)assert.equal(plan.entries.find(entry=>entry.family===family&&entry.name===f.input.promotionId)?.decision,"keep");
    assert.equal(plan.entries.find(entry=>entry.family==="doctor-jobs"&&entry.name===f.jobId)?.decision,"keep");
    assert.equal(plan.entries.find(entry=>entry.family==="manager-generations"&&entry.name===f.unrelated.unrelated.generationId)?.decision,"retire");
  }finally{disposeRetainedFixture(f.managerRoot);disposeRetainedFixture(f.unrelated.root);}
});
test("accepted runtime repair retention blocks affected families for missing bound worker or immutable proof",()=>{
  for(const missing of ["original-worker","delegated-worker","source-proof"]){
    const f=retainedChildFixture();try{
      const path=missing==="source-proof"?f.authority.sourceDelta.reviewedDelta.path:join(dirname((missing==="original-worker"?f.old:f.next).worker.launcherPath),"target.seal");
      chmodSync(dirname(path),0o700);rmSync(path);
      const plan=f.plan();assert.match(plan.families["manager-generations"].blocked??"",/Accepted runtime repair.*proof is unreadable/);
      for(const family of ["manager-generations","manager-runtime-generations","manager-managed-runtime-generations","variant-builds","variant-previous","doctor-jobs"])
        assert.equal(plan.entries.some(entry=>entry.family===family&&entry.decision==="retire"),false);
    }finally{disposeRetainedFixture(f.managerRoot);disposeRetainedFixture(f.unrelated.root);}
  }
});
test("accepted runtime repair retention rejects linked public malformed and foreign fixed heads",()=>{
  for(const fault of ["linked","public","malformed","foreign"]){
    const f=retainedChildFixture();try{
      if(fault==="linked"){const bytes=readFileSync(f.head),external=join(f.managerRoot,"external-head.json");writeFileSync(external,bytes,{mode:0o600});rmSync(f.head);symlinkSync(external,f.head);}
      if(fault==="public")chmodSync(f.head,0o644);
      if(fault==="malformed")writeFileSync(f.head,'{"version":99}');
      if(fault==="foreign"){const head=JSON.parse(readFileSync(f.head,"utf8"));head.operationId=operationId;writeJson(f.head,head);}
      const plan=f.plan();assert.match(plan.families["manager-generations"].blocked??"",/Accepted runtime repair.*proof is unreadable/);
      assert.equal(plan.entries.some(entry=>entry.family.startsWith("manager-")&&entry.decision==="retire"),false);
    }finally{disposeRetainedFixture(f.managerRoot);disposeRetainedFixture(f.unrelated.root);}
  }
});

test("accepted runtime repair retention preserves the complete depth-two lineage after displacement and blocks a missing predecessor",()=>{
  for(const missing of [false,true]) {
    const f=retainedChildFixture(true);try {
      assert.equal(f.child.head.version,2);
      if(f.authority.version!==2)throw new Error("V2 fixture required");
      const previous=f.authority.predecessor.publication.path;
      if(missing)rmSync(previous);
      const plan=f.plan();
      if(missing) {
        assert.match(plan.families["manager-generations"].blocked??"",/Accepted runtime repair.*proof is unreadable/);
        assert.equal(plan.entries.some(entry=>entry.family.startsWith("manager-")&&entry.decision==="retire"),false);
      }else {
        assert.equal(plan.families["manager-generations"].blocked,null);
        for(const worker of [f.old.worker,f.next.worker,("predecessorAuthority" in f?f.predecessorAuthority.authorizedWorker:null)]) {
          assert.ok(worker);
          assert.equal(plan.entries.find(entry=>entry.family==="manager-generations"&&entry.name===worker.generationId)?.decision,"keep");
        }
        for(const family of ["variant-builds","variant-previous"] as const)
          assert.equal(plan.entries.find(entry=>entry.family===family&&entry.name===f.input.promotionId)?.decision,"keep");
      }
    }finally{disposeRetainedFixture(f.managerRoot);disposeRetainedFixture(f.unrelated.root);}
  }
});

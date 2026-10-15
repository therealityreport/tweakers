import assert from "node:assert/strict";
import test from "node:test";
import { createAcceptedRuntimeRepairEffectiveActiveReceipt, createAcceptedRuntimeRepairEffectiveJournal,
  parseAcceptedRuntimeRepairAction, scanAcceptedRuntimeRepairSuccessor, assertAcceptedRuntimeRepairPredecessorAcceptanceAbsentForTest, resumeAcceptedRuntimeRepair, finishAcceptedRuntimeRepairFromRetainedAcceptance,
  acceptedRuntimeRepairRenameDisposition, acceptedRuntimeRepairApprovalDisposition, acceptedRuntimeRepairIntentPublicationTime, prepareAcceptedRuntimeRepairStagingForTest,
  supersededNativeReplacementOperation, nativeReplacementRetirementDisposition } from "../src/accepted-runtime-repair.js";
import { assertAcceptedRuntimeRepairOriginalOperationProjection } from "@therealityreport/tweakers-sdk";

const operationId="00000000-0000-4000-8000-000000000001",jobId="00000000-0000-4000-8000-000000000002";
const generation=(digit:string)=>({kind:"directory" as const,mode:0o700,sha256:digit.repeat(64)});

test("accepted runtime repair fixed Doctor envelope admits only exact scan approve and recover fields",()=>{
  for(const action of ["scan","scan-successor","recover","prepare-native-replacement"] as const) {
    const request={kind:"tweakers-accepted-runtime-repair-action",version:1,action,operationId};
    assert.deepEqual(parseAcceptedRuntimeRepairAction(request),request);
    for(const extra of [{root:"/other"},{worker:"caller"},{runtime:"/replacement"},{scopes:{}},{approved:true}])
      assert.throws(()=>parseAcceptedRuntimeRepairAction({...request,...extra}),/fixed repair action/);
    assert.throws(()=>parseAcceptedRuntimeRepairAction({...request,operationId:"../other"}),/original operation/);
  }
  const request={kind:"tweakers-accepted-runtime-repair-action",version:1,action:"approve",jobId,reportFingerprint:`sha256:${"a".repeat(64)}`};
  assert.deepEqual(parseAcceptedRuntimeRepairAction(request),request);
  for(const changed of [{...request,operationId},{...request,reportFingerprint:"a".repeat(64)},{...request,action:"publish"},{...request,version:2}])
    assert.throws(()=>parseAcceptedRuntimeRepairAction(changed));
});

test("native replacement preserves failed-operation evidence and cannot grant old repair acceptance or resume",()=>{
  const original:any={phase:"recovery-required",actionId:"refresh.independent",consumedAt:"2026-10-12T12:00:00.000Z",recoveryRequiredAt:"2026-10-12T12:01:00.000Z",
    failedAt:null,completedAt:null,cancelledAt:null,outcome:"recovery-required",error:"original failed startup evidence",
    parameters:{source:"original"},moduleIdentity:{sha256:"a".repeat(64)},receiptRefs:["immutable journal"]};
  const snapshot=structuredClone(original),at="2026-10-12T12:02:00.000Z",failed=supersededNativeReplacementOperation(original,at);
  assert.deepEqual(original,snapshot);
  assert.equal(failed.phase,"failed");assert.equal(failed.completedAt,null);assert.equal(failed.cancelledAt,null);assert.equal(failed.failedAt,at);
  for(const field of ["consumedAt","error","parameters","moduleIdentity","receiptRefs"] as const)assert.deepEqual(failed[field],original[field]);
  assert.throws(()=>assertAcceptedRuntimeRepairOriginalOperationProjection(original,failed),"old startup/resume contract must reject supersession as acceptance");
  for(const changed of [{...original,phase:"completed"},{...original,phase:"prepared",consumedAt:null},{...original,consumedAt:null}])
    assert.throws(()=>supersededNativeReplacementOperation(changed,at));
  assert.throws(()=>supersededNativeReplacementOperation(original,"2026-10-12T11:59:00.000Z"));
});

test("native replacement interruption replay preserves exactly one app and rejects ambiguous custody",()=>{
  assert.equal(nativeReplacementRetirementDisposition(true,false),"move");
  assert.equal(nativeReplacementRetirementDisposition(false,true),"retained");
  assert.throws(()=>nativeReplacementRetirementDisposition(true,true),/exactly one retained app/);
  assert.throws(()=>nativeReplacementRetirementDisposition(false,false),/exactly one retained app/);
});

test("accepted runtime repair effective projections retain immutable original journal app pair and unrelated entries",()=>{
  const old=generation("a"),repaired=generation("b"),active=generation("c"),root="/private/manager/variants/tweakers/builds/p/runtime-repair/accepted/operations/r";
  const original:any={version:3,id:"promotion",userRoot:"/private/manager/variants/tweakers",target:"/Applications/Tweakers.app",phase:"app:promoted",
    candidate:"/candidate",buildRoot:"/build",acceptedBackendTransition:{operationId,lane:{exactSignedPair:"preserved"}},
    entries:[{name:"runtime",desired:old,source:"/old-source",archive:"/old-archive",destination:"/runtime"},{name:"app",desired:old,destination:"/Applications/Tweakers.app"}],
    activeReceipt:{source:"/active-source",destination:"/active",archive:"/active-archive",failed:"/active-failed",desired:old,previous:old,hadDestination:true,
      expected:{version:3,id:"promotion",userRoot:"/private/manager/variants/tweakers",target:"/Applications/Tweakers.app",
        entries:[{name:"runtime",path:"/runtime",fingerprint:old},{name:"app",path:"/Applications/Tweakers.app",fingerprint:old}]}}};
  const frozen=structuredClone(original),effectiveActive=createAcceptedRuntimeRepairEffectiveActiveReceipt(original,jobId,"d".repeat(64),repaired);
  const projected=createAcceptedRuntimeRepairEffectiveJournal(original,root,repaired,effectiveActive,active) as any;
  assert.deepEqual(original,frozen,"producer must not retcon original promotion bytes");
  assert.deepEqual(projected.acceptedBackendTransition,original.acceptedBackendTransition);
  assert.deepEqual(projected.entries[1],original.entries[1]);
  assert.deepEqual(projected.entries[0],{...original.entries[0],desired:repaired});
  assert.equal(projected.phase,"committed");
  assert.deepEqual(projected.activeReceipt,{...original.activeReceipt,source:`${root}/effective-active-receipt.json`,archive:`${root}/prior-active-receipt.json`,
    failed:`${root}/failed-active-receipt.json`,desired:active,expected:effectiveActive});
  assert.deepEqual((effectiveActive as any).entries[1],original.activeReceipt.expected.entries[1]);
  assert.deepEqual((effectiveActive as any).runtimeRepair,{repairId:jobId,authorityReceiptSha256:"d".repeat(64)});
});

test("accepted runtime repair refuses absent withheld or asynchronous admission before reading authority or mutating",()=>{
  assert.throws(()=>resumeAcceptedRuntimeRepair(operationId,{} as any),/maintained closed and accepted-process guards/);
  let called=0;
  assert.throws(()=>resumeAcceptedRuntimeRepair(operationId,{assertClosedAdmission(){called++;throw new Error("desktop appeared");},assertAcceptedProcess(){}}),/desktop appeared/);
  assert.equal(called,1);
  assert.throws(()=>resumeAcceptedRuntimeRepair(operationId,{assertClosedAdmission:(()=>Promise.resolve()) as any,assertAcceptedProcess(){}}),/synchronous closed/);
  assert.throws(()=>finishAcceptedRuntimeRepairFromRetainedAcceptance(operationId,(()=>true) as any),/synchronous closed/);
});

test("accepted runtime repair crash replay distinguishes before and after each journaled rename without permitting lost or duplicated generations",()=>{
  for(const phase of ["runtime:archive-planned","runtime:promote-planned","active:archive-planned","active:promote-planned"] as const) {
    assert.equal(acceptedRuntimeRepairRenameDisposition(phase,true,false),"rename",`crash before ${phase} rename retains source`);
    assert.equal(acceptedRuntimeRepairRenameDisposition(phase,false,true),"published",`crash after ${phase} rename retains destination`);
    assert.throws(()=>acceptedRuntimeRepairRenameDisposition(phase,true,true),/exactly one retained/);
    assert.throws(()=>acceptedRuntimeRepairRenameDisposition(phase,false,false),/exactly one retained/);
  }
  for(const phase of ["prepared","runtime:archived","challenge:published","acceptance:verified","committed"] as const)
    assert.throws(()=>acceptedRuntimeRepairRenameDisposition(phase,true,false),/explicit planned/);
});

test("accepted runtime repair renews only an expired unused exact approval and never a consumed or foreign review",()=>{
  const prior={version:1 as const,kind:"tweakers-doctor-runtime-repair-approval" as const,operationId,repairId:jobId,jobId,
    reportFingerprint:`sha256:${"a".repeat(64)}`,authoritySha256:"b".repeat(64),workerGenerationId:"c".repeat(64),
    promotionFingerprint:`sha256:${"d".repeat(64)}`,approvedAt:"2026-10-12T14:00:00.000Z",expiresAt:"2026-10-12T14:05:00.000Z"};
  const next={...prior,approvedAt:"2026-10-12T14:06:00.000Z",expiresAt:"2026-10-12T14:11:00.000Z"};
  assert.equal(acceptedRuntimeRepairApprovalDisposition(prior,next,Date.parse(next.approvedAt),false),"renew");
  assert.equal(acceptedRuntimeRepairApprovalDisposition(prior,next,Date.parse("2026-10-12T14:01:00.000Z"),false),"current");
  assert.equal(acceptedRuntimeRepairApprovalDisposition(prior,next,Date.parse(next.approvedAt),true),"current","intent/head consumption forbids renewal");
  for(const altered of [{...prior,jobId:operationId},{...prior,authoritySha256:"e".repeat(64)},{...prior,workerGenerationId:"f".repeat(64)},
    {...prior,reportFingerprint:`sha256:${"e".repeat(64)}`}])
    assert.throws(()=>acceptedRuntimeRepairApprovalDisposition(altered,next,Date.parse(next.approvedAt),false),/foreign or drifted/);
  assert.throws(()=>acceptedRuntimeRepairApprovalDisposition(prior,next,NaN,false),/foreign or drifted/);
});

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRuntimeFingerprint } from "../src/runtime-fingerprint.js";
import { fingerprintVariantGeneration } from "../src/variant-generation.js";
import { prepareProbedAccountsTransferRecovery } from "../src/accounts-transfer-compatibility.js";

function sealedStagingFixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"accepted-runtime-repair-staging-")));chmodSync(root,0o700);
  const source=join(root,"sealed"),child=join(root,"child");mkdirSync(source,{mode:0o700});mkdirSync(child,{mode:0o700});
  const router=join(source,"account-router");mkdirSync(router,{mode:0o700});
  writeFileSync(join(router,"native-transfer.js"),"exports.ACCOUNTS_TRANSFER_READER_VERSION=2;exports.inspectNativeTransferCompatibilityV2=(m,v)=>({state:m&&v<2?'incompatible':'compatible'});",{mode:0o400});
  writeFileSync(join(router,"native-source-retirement.js"),"exports.ACCOUNTS_SOURCE_RETIREMENT_READER_VERSION=2;exports.inspectNativeSourceRetirementCompatibilityV2=v=>({state:v===2?'compatible':'incompatible',minimumVersion:2});",{mode:0o400});
  writeFileSync(join(source,"runtime-fingerprint.json"),JSON.stringify({schemaVersion:1,...computeRuntimeFingerprint(source)})+'\n',{mode:0o400});
  chmodSync(router,0o500);chmodSync(source,0o500);
  return{root,source,child};
}
function disposeStagingFixture(path:string):void{
  const status=lstatSync(path);if(status.isSymbolicLink()){rmSync(path);return;}
  if(status.isDirectory()){chmodSync(path,0o700);for(const name of readdirSync(path))disposeStagingFixture(join(path,name));}
  rmSync(path,{recursive:true,force:true});
}
test("accepted runtime repair production scan staging keeps sealed bytes and leaf modes while allocating private writable directories",()=>{
  const f=sealedStagingFixture();try{
    const before=fingerprintVariantGeneration(f.source),document=readFileSync(join(f.source,"runtime-fingerprint.json")),baseline=computeRuntimeFingerprint(f.source);
    const next=prepareAcceptedRuntimeRepairStagingForTest(f.child,f.source);
    assert.equal(lstatSync(next).mode&0o777,0o700);assert.equal(lstatSync(join(next,"account-router")).mode&0o777,0o700);
    assert.equal(lstatSync(join(next,"account-router","native-transfer.js")).mode&0o777,0o400);
    assert.deepEqual(computeRuntimeFingerprint(next),baseline);assert.deepEqual(readFileSync(join(next,"runtime-fingerprint.json")),document);
    // The production scan then invokes the real maintained preparer. No mocked
    // permissions or signature success is involved at this preparation seam.
    prepareProbedAccountsTransferRecovery(next,join(f.child,"accounts-transfer-recovery"));
    assert.equal(existsSync(join(next,"accounts-transfer-recovery.v1.json")),true);
    assert.equal(lstatSync(join(f.child,"accounts-transfer-recovery")).mode&0o777,0o700);
    assert.deepEqual(fingerprintVariantGeneration(f.source),before);
  }finally{disposeStagingFixture(f.root);}
});
test("accepted runtime repair fresh staging rejects replaced child parent without copying into or chmodding the replacement sentinel",()=>{
  const f=sealedStagingFixture();try{
    const sentinel=join(f.root,"sentinel");mkdirSync(sentinel,{mode:0o700});writeFileSync(join(sentinel,"protected"),"unchanged",{mode:0o400});
    assert.throws(()=>prepareAcceptedRuntimeRepairStagingForTest(f.child,f.source,()=>{renameSync(f.child,join(f.root,"retained-child"));symlinkSync(sentinel,f.child);}),/canonical|owner-private|retained|linked/);
    assert.equal(readFileSync(join(sentinel,"protected"),"utf8"),"unchanged");assert.equal(lstatSync(join(sentinel,"protected")).mode&0o777,0o400);
    assert.equal(existsSync(join(sentinel,"next-runtime")),false);
    assert.equal(lstatSync(join(f.root,"retained-child","next-runtime")).mode&0o777,0o500,"rejected ancestry preserves copied evidence without permission mutations");
  }finally{disposeStagingFixture(f.root);}
});
test("accepted runtime repair intent publication reads a fresh clock after preparation and rejects intervening approval expiry",()=>{
  const approval={approvedAt:"2026-10-12T14:00:00Z",expiresAt:"2026-10-12T14:05:00Z"} as any;
  let now=Date.parse("2026-10-12T14:04:00Z");
  assert.equal(acceptedRuntimeRepairIntentPublicationTime(approval,()=>now),"2026-10-12T14:04:00.000Z");
  now=Date.parse("2026-10-12T14:05:01Z");assert.throws(()=>acceptedRuntimeRepairIntentPublicationTime(approval,()=>now),/expired before intent publication/);
  assert.throws(()=>acceptedRuntimeRepairIntentPublicationTime(approval,()=>NaN),/expired/);
});


import { fileURLToPath } from "node:url";
import { doctorCodeScopeFingerprint, doctorImplementationScopes } from "../src/doctor-implementation.js";

test("accepted runtime repair implementation scope fingerprints bind the actual source and emitted construction verification promotion graphs",()=>{
  const runtime=realpathSync(fileURLToPath(new URL("../assets/runtime/",import.meta.url)));
  const entries:Array<[string,Array<[string,string[]]>]>=[
    ["construction",[["commands/create-variant",["createTweakersVariantCandidateOnly"]],
      ["shared-native-backend-transition",["sealAcceptedSharedNativeBackendTransition","assertAcceptedSharedNativeBackendTransitionClosure"]]]],
    ["verification",[["doctor-validation",["collectDoctorValidation"]],
      ["doctor-compatibility",["DOCTOR_CORE_CHECKS","makeDoctorCompatibility","assertDoctorCompatibility"]]]],
    ["promotion",[["commands/create-variant",["createTweakersVariant","resumeDeferredAcceptedBackendTransition","replayAcceptedBackendTransition",
      "assertAcceptedBackendTransitionResumeAdmission","stageIndependentTweakersRuntimeReadyExpectation","readRuntimeReadyPromotionReceiptSha256","commitPromotedVariantJournal"]],
      ["doctor-approval",["consumeDoctorCandidateApproval"]],["shared-native-backend-transition",["AcceptedBackendTransitionJournal"]],
      ["manager-action-adapter",["createSealedTweakersManagerActionAdapter"]]]],
    ["repair",[["accepted-runtime-repair",["*"]]]],
  ];
  const failures:string[]=[];
  // Parse and hash genuine production declarations without executing any
  // candidate, signature verifier or runtime adapter. Collect failures across
  // all graphs, so publication cannot discover them one scope at a time.
  for(const directory of ["src","dist"]){
    const modules=realpathSync(fileURLToPath(new URL(`../${directory}/`,import.meta.url)));
    for(const [scope,graph] of entries){
      try{assert.match(doctorCodeScopeFingerprint(modules,graph),/^sha256:[a-f0-9]{64}$/);}
      catch(error){failures.push(`${directory}:${scope}: ${error instanceof Error?error.message:String(error)}`);}
    }
    try{
      const scopes=doctorImplementationScopes(modules,runtime);
      for(const key of ["construction","verification","promotion","payload"] as const)assert.match(scopes[key],/^sha256:[a-f0-9]{64}$/);
    }catch(error){failures.push(`${directory}:combined: ${error instanceof Error?error.message:String(error)}`);}
  }
  assert.deepEqual(failures,[],"every actual scope graph must resolve before sealed Doctor dispatch");
  const root=realpathSync(mkdtempSync(join(tmpdir(),"repair-scope-unknown-")));chmodSync(root,0o700);
  try{
    writeFileSync(join(root,"package-lock.json"),"{}\n",{mode:0o600});
    writeFileSync(join(root,"accepted-runtime-repair.js"),
      'import { createRequire } from "node:module"; import { join } from "node:path"; export function unknown(){return createRequire(import.meta.url)(join(runtimeRoot,"unreviewed.js"));}',{mode:0o600});
    assert.throws(()=>doctorCodeScopeFingerprint(root,[["accepted-runtime-repair",["unknown"]]]),/Unbound dynamic scoped loader: accepted-runtime-repair:.*unreviewed/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

import { assertAcceptedRuntimeRepairHeadContract, assertAcceptedRuntimeRepairIntentContract, assertDoctorRuntimeRepairAuthorityContract } from "@therealityreport/tweakers-sdk";
import { completeAcceptedRuntimeRepairSuccessorFixture } from "../../runtime/test/accepted-runtime-repair-fixture.js";
import { createHash } from "node:crypto";
import { canonicalManagerJson } from "../src/manager-contract.js";

test("accepted runtime repair successor refuses withheld or asynchronous closed admission before authority reads",async()=>{
  await assert.rejects(scanAcceptedRuntimeRepairSuccessor(operationId,undefined as any),/synchronous closed/);
  await assert.rejects(scanAcceptedRuntimeRepairSuccessor(operationId,(()=>Promise.resolve()) as any),/synchronous closed/);
  await assert.rejects(scanAcceptedRuntimeRepairSuccessor(operationId,()=>{throw new Error("desktop appeared");}),/desktop appeared/);
});

test("accepted runtime repair V2 producer binds exactly one immutable V1 predecessor and rejects contract drift",()=>{
  const f=completeAcceptedRuntimeRepairSuccessorFixture("challenge:published");
  try {
    const deps={isCanonicalAbsolutePath:(path:string)=>path.startsWith("/")&&!path.includes("/../"),sha256:(text:string)=>createHash("sha256").update(text).digest("hex")};
    assertAcceptedRuntimeRepairHeadContract(f.predecessor.head);
    assertAcceptedRuntimeRepairHeadContract(f.child.head);
    assertDoctorRuntimeRepairAuthorityContract(f.authority,deps);
    assertAcceptedRuntimeRepairIntentContract(f.child.intent,deps);
    assert.equal(f.child.head.version,2);assert.equal(f.predecessor.head.version,1);
    assert.deepEqual(f.child.head.prior,f.predecessor.runtimeRepair);
    assert.deepEqual(f.authority.priorRuntime,f.predecessorAuthority.priorRuntime);
    assert.deepEqual(f.authority.predecessor.installedRuntime,f.predecessorAuthority.repairedRuntime.generation);
    assert.notDeepEqual(f.authority.predecessor.installedRuntime,f.authority.priorRuntime);
    for(const head of [{...f.child.head,version:3},{...f.child.head,prior:null},
      {...f.child.head,repairId:f.predecessor.head.repairId},{...f.child.head,prior:{...f.child.head.prior,unexpected:true}}])
      assert.throws(()=>assertAcceptedRuntimeRepairHeadContract(head));
    assert.throws(()=>assertDoctorRuntimeRepairAuthorityContract({...f.authority,expectedPriorHeadSha256:"f".repeat(64)},deps));
    for(const intent of [{...f.child.intent,version:1},{...f.child.intent,operationId:jobId},
      {...f.child.intent,prior:{...f.child.intent.prior,authorityReceiptSha256:"f".repeat(64)}}])
      assert.throws(()=>assertAcceptedRuntimeRepairIntentContract(intent,deps));
  }finally{disposeStagingFixture(f.managerRoot);}
});

test("accepted runtime repair prepublication filesystem boundary rejects partial-valid maintained acceptance before head or runtime changes",()=>{
  for(const fault of ["valid-successor","empty-receipt","extra-proof-key","pid-drift","early-observation","missing-tweak","wrong-filename","genuine-predecessor"] as const) {
    const f=completeAcceptedRuntimeRepairSuccessorFixture("challenge:published");try {
      const accepted=fault==="genuine-predecessor"?f.predecessor:f.child;
      f.recordAcceptance(accepted);
      const proof=JSON.parse(readFileSync(join(accepted.root,"acceptance.json"),"utf8"));
      let source=JSON.parse(readFileSync(join(accepted.root,"acceptance-source.json"),"utf8")).sourcePath;
      proof.expectation.expectedTweakIds=["co.tweakers.projects"];
      proof.receipt.initializedTweakIds=[...proof.expectation.expectedTweakIds];
      const canonicalSource=join(f.managerRoot,"transactions","manager-recovery-bindings",`${f.input.operationId}.acceptance.${createHash("sha256").update(canonicalManagerJson(proof.receipt)).digest("hex")}.json`);
      if(source!==canonicalSource){renameSync(source,canonicalSource);source=canonicalSource;}
      rmSync(join(accepted.root,"acceptance.json"));rmSync(join(accepted.root,"acceptance-source.json"));
      if(fault==="empty-receipt")proof.receipt={};
      if(fault==="extra-proof-key")proof.verified=true;
      if(fault==="pid-drift")proof.pid++;
      if(fault==="early-observation")proof.receipt.observedAt="2026-10-12T12:00:00Z";
      if(fault==="missing-tweak")proof.receipt.initializedTweakIds=[];
      let path=source;
      if(fault==="wrong-filename"){path=join(f.managerRoot,"transactions","manager-recovery-bindings",`${f.input.operationId}.acceptance.${"f".repeat(64)}.json`);renameSync(source,path);}
      writeFileSync(path,JSON.stringify(proof)+"\n");
      const headPath=join(f.managerRoot,"transactions","manager-recovery-bindings",`${f.input.operationId}.runtime-repair-head.json`),headBytes=readFileSync(headPath),runtime=fingerprintVariantGeneration(join(f.userRoot,"runtime"));
      const boundary=()=>assertAcceptedRuntimeRepairPredecessorAcceptanceAbsentForTest(f.managerRoot,{root:f.predecessor.root,head:f.predecessor.head,intent:f.predecessor.intent} as any);
      if(fault==="valid-successor")boundary();else assert.throws(boundary);
      assert.deepEqual(readFileSync(headPath),headBytes,"absence validation must reject before changing the current head");
      assert.deepEqual(fingerprintVariantGeneration(join(f.userRoot,"runtime")),runtime,"no runtime publication on invalid evidence");
    }finally{disposeStagingFixture(f.managerRoot);}
  }
});

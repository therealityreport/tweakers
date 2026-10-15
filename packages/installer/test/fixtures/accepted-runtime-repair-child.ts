/** Test-only byte producer. Signature verification is mocked only by the
 * consuming gate's explicit signature test port; production never imports this. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertAcceptedRuntimeRepairIntentContract, type AcceptedRuntimeRepairConsumedApprovalV1,
  type DoctorRuntimeRepairAuthority, type AcceptedRuntimeRepairIntent, type AcceptedRuntimeRepairHead } from "@therealityreport/tweakers-sdk";
import { fingerprintVariantGeneration } from "../../src/variant-generation.js";
import { createAcceptedRuntimeRepairEffectiveActiveReceipt, createAcceptedRuntimeRepairEffectiveJournal } from "../../src/accepted-runtime-repair.js";

const sha=(value:Buffer|string):string=>createHash("sha256").update(value).digest("hex");
export function produceAcceptedRuntimeRepairChildFixture(input:{managerRoot:string;userRoot:string;authority:DoctorRuntimeRepairAuthority;
  originalJournal:Record<string,any>;originalExpectation:Record<string,unknown>;phase:"challenge:published"|"committed"}) {
  const {authority}=input,root=join(input.userRoot,"builds",authority.promotionId,"runtime-repair","accepted","operations",authority.repairId);
  const write=(path:string,value:unknown)=>{mkdirSync(join(path,".."),{recursive:true,mode:0o700});const bytes=Buffer.from(JSON.stringify(value)+"\n");
    writeFileSync(path,bytes,{mode:0o600});return{path,sha256:sha(bytes)};};
  const bundle=join(root,"receipt","TweakersRuntimeRepairReceipt.bundle"),resource=join(bundle,"Contents","Resources","runtime-repair.json");
  const signed=write(resource,authority);
  const approval:AcceptedRuntimeRepairConsumedApprovalV1={version:1,kind:"tweakers-doctor-runtime-repair-approval",operationId:authority.operationId,
    repairId:authority.repairId,jobId:authority.review.jobId,reportFingerprint:authority.review.reportFingerprint,authoritySha256:signed.sha256,
    workerGenerationId:authority.authorizedWorker.generationId,promotionFingerprint:authority.review.promotionFingerprint,
    approvedAt:authority.version===2?"2026-10-12T14:10:00.000Z":"2026-10-12T14:00:00.000Z",expiresAt:authority.version===2?"2026-10-12T14:15:00.000Z":"2026-10-12T14:05:00.000Z"};
  const consumedApproval=write(join(root,"consumed-doctor-approval.json"),approval);
  const active=createAcceptedRuntimeRepairEffectiveActiveReceipt(input.originalJournal as {activeReceipt:{expected:Record<string,any>}},authority.repairId,signed.sha256,authority.repairedRuntime.generation);
  const effectiveActiveReceipt=write(join(root,"effective-active-receipt.json"),active);
  const activeGeneration=fingerprintVariantGeneration(effectiveActiveReceipt.path);
  const effectiveJournal=write(join(root,"effective-journal.json"),createAcceptedRuntimeRepairEffectiveJournal(input.originalJournal,root,
    authority.repairedRuntime.generation,active,activeGeneration));
  const intent:AcceptedRuntimeRepairIntent=authority.version===2
    ?{version:2,kind:"tweakers-accepted-runtime-repair-intent",operationId:authority.operationId,promotionId:authority.promotionId,repairId:authority.repairId,
      prior:authority.predecessor.binding,authority,authorityReceipt:{bundleGeneration:fingerprintVariantGeneration(bundle),jsonSha256:signed.sha256},
      consumedApproval,effectiveJournal,effectiveActiveReceipt,createdAt:"2026-10-12T14:11:00.000Z"}
    :{version:1,kind:"tweakers-accepted-runtime-repair-intent",operationId:authority.operationId,promotionId:authority.promotionId,repairId:authority.repairId,
      prior:null,authority,authorityReceipt:{bundleGeneration:fingerprintVariantGeneration(bundle),jsonSha256:signed.sha256},
      consumedApproval,effectiveJournal,effectiveActiveReceipt,createdAt:"2026-10-12T14:01:00.000Z"};
  assertAcceptedRuntimeRepairIntentContract(intent,{isCanonicalAbsolutePath:p=>p.startsWith("/"),sha256:sha});
  const intentRef=write(join(root,"intent.json"),intent);
  const head:AcceptedRuntimeRepairHead=intent.version===2
    ?{version:2,kind:"tweakers-accepted-runtime-repair-head",operationId:authority.operationId,promotionId:authority.promotionId,
      repairId:authority.repairId,intentSha256:intentRef.sha256,prior:intent.prior}
    :{version:1,kind:"tweakers-accepted-runtime-repair-head",operationId:authority.operationId,promotionId:authority.promotionId,
      repairId:authority.repairId,intentSha256:intentRef.sha256,prior:null};
  const headRef=write(join(root,"head.json"),head);
  write(join(input.managerRoot,"transactions","manager-recovery-bindings",`${authority.operationId}.runtime-repair-head.json`),head);
  write(join(root,"publication.json"),{version:1,kind:"tweakers-accepted-runtime-repair-publication",operationId:authority.operationId,
    promotionId:authority.promotionId,repairId:authority.repairId,intentSha256:intentRef.sha256,phase:input.phase});
  const runtimeRepair={repairId:authority.repairId,headSha256:headRef.sha256,intentSha256:intentRef.sha256,authorityReceiptSha256:signed.sha256};
  const expectation={...input.originalExpectation,schemaVersion:6,runtimeRepair,runtimeFingerprint:authority.repairedRuntime.evidence.fingerprint,
    activePromotionReceiptSha256:activeGeneration.sha256,createdAt:authority.version===2?"2026-10-12T14:12:00.000Z":"2026-10-12T14:02:00.000Z"};
  write(join(input.userRoot,"runtime-ready-expectation.json"),expectation);
  return{root,intent,head,runtimeRepair,expectation,effectiveJournal:effectiveJournal.path,effectiveActiveReceipt:effectiveActiveReceipt.path};
}

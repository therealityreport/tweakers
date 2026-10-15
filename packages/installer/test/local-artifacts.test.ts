import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindMissingArtifactRecovery, inspectLocalArtifactCapacity, readReservations, reconcileMissingArtifactRecovery } from "../src/local-artifacts";
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"artifact-recovery-cas-"))),original=join(root,"failed.app"),id=randomUUID(),transactionId=randomUUID();
  const reservation={id,paths:[original],state:"partial" as const,operationId:randomUUID(),ownerPid:999999,ownerStartedAt:"dead",generationIdentity:{dev:1,ino:2}};
  writeFileSync(join(root,"local-artifact-reservations.json"),JSON.stringify({version:1,reservations:[reservation]}),{mode:0o600});
  const recovery={transactionId,manifest:join(root,"artifact-archives/missing-artifact-recovery",transactionId,"input.json"),manifestSHA256:"a".repeat(64),
    proof:{kind:"private-apfs-verification-image" as const,image:`/Volumes/SHOWS DB/_Mac-Archive/Tweakers/failed-promotions/${transactionId}.missing-restore.sparseimage`,mount:`/Volumes/TweakersArchiveVerify-${transactionId}`}};
  return {root,reservation,recovery,original,dispose:()=>rmSync(root,{recursive:true,force:true})};
}
test("full-record allocation CAS preserves occupied partial state and rejects changed provenance",()=>{
  const f=fixture();try{assert.throws(()=>bindMissingArtifactRecovery(f.root,{...f.reservation,ownerStartedAt:"wrong"},f.recovery),/changed/);
    const bound=bindMissingArtifactRecovery(f.root,f.reservation,f.recovery);assert.equal(bound.state,"partial");assert.deepEqual(bound.generationIdentity,f.reservation.generationIdentity);
    assert.equal(inspectLocalArtifactCapacity(f.root,join(f.root,"installed.app")).occupied,1);
    assert.throws(()=>bindMissingArtifactRecovery(f.root,bound,f.recovery),/changed/);
  }finally{f.dispose();}
});
test("a reappearing exact historical inode is an extra copy rather than the proof allocation",()=>{
  const f=fixture();try{mkdirSync(f.original);const st=lstatSync(f.original),reservation={...f.reservation,generationIdentity:{dev:st.dev,ino:st.ino}};
    writeFileSync(join(f.root,"local-artifact-reservations.json"),JSON.stringify({version:1,reservations:[{...reservation,missingRecovery:f.recovery}]}),{mode:0o600});
    const capacity=inspectLocalArtifactCapacity(f.root,join(f.root,"installed.app"));assert.equal(capacity.occupied,2);assert.match(capacity.blockers.join(" "),/reappeared/);
  }finally{f.dispose();}
});
test("receipt validation failure or changed reservation cannot release the slot",()=>{
  const f=fixture();try{const bound=bindMissingArtifactRecovery(f.root,f.reservation,f.recovery),before=readFileSync(join(f.root,"local-artifact-reservations.json"));
    assert.throws(()=>reconcileMissingArtifactRecovery(f.root,bound,"receipt",()=>{throw new Error("Invalid successor");}),/Invalid successor/);
    assert.deepEqual(readFileSync(join(f.root,"local-artifact-reservations.json")),before);
    assert.throws(()=>reconcileMissingArtifactRecovery(f.root,{...bound,ownerPid:10},"receipt",()=>{}),/changed/);assert.equal(readReservations(f.root)[0]!.state,"partial");
  }finally{f.dispose();}
});

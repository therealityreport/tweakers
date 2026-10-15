import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireRefreshLock } from "../src/commands/refresh-local";
import { acquireProcessLock, processAlive } from "../src/process-lock";

function fixture(): { root: string; lockFile: string } {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-lock-"));
  return { root, lockFile: join(root, "refresh-local.lock") };
}

test("processAlive treats PID 1 as alive", () => {
  assert.equal(processAlive(1), true);
});

test("the shared process lock reclaims a stale owner", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "999999\n");
    const lock = acquireProcessLock(lockFile);
    assert.equal(Number.parseInt(readFileSync(lockFile, "utf8"), 10), process.pid);
    lock.release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale reclamation elects one claimant before any contender can replace its live lock", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "999999\n");
    let nestedAttempted = false;
    const lock = acquireProcessLock(lockFile, {
      afterClaimed: () => {
        nestedAttempted = true;
        assert.throws(
          () => acquireProcessLock(lockFile),
          new RegExp(`PID ${process.pid}`),
        );
      },
    });
    assert.equal(nestedAttempted, true);
    assert.equal(Number.parseInt(readFileSync(lockFile, "utf8"), 10), process.pid);
    lock.release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shared process lock preserves a live owner's lock", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "1\n");
    const contended = new Error("contended");
    assert.throws(
      () => acquireProcessLock(lockFile, {
        onContended: (owner) => {
          assert.equal(owner, 1);
          return contended;
        },
      }),
      (error) => error === contended,
    );
    assert.equal(readFileSync(lockFile, "utf8"), "1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a throwing contention callback still removes the elected ticket", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "1\n");
    assert.throws(
      () => acquireProcessLock(lockFile, {
        onContended: () => { throw new Error("contention callback failed"); },
      }),
      /contention callback failed/,
    );
    assert.equal(readFileSync(lockFile, "utf8"), "1\n");
    assert.deepEqual(readdirSync(`${lockFile}.claims`), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shared process lock also preserves a live same-process lock", () => {
  const { root, lockFile } = fixture();
  const first = acquireProcessLock(lockFile);
  try {
    assert.throws(
      () => acquireProcessLock(lockFile),
      new RegExp(`PID ${process.pid}`),
    );
    assert.equal(Number.parseInt(readFileSync(lockFile, "utf8"), 10), process.pid);
  } finally {
    first.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failure during the settled claim inspection removes the live ticket", () => {
  const { root, lockFile } = fixture();
  try {
    assert.throws(
      () => acquireProcessLock(lockFile, {
        beforeSettledInspection: () => { throw new Error("second inspection failed"); },
      }),
      /second inspection failed/,
    );
    assert.equal(existsSync(lockFile), false);
    assert.deepEqual(readdirSync(`${lockFile}.claims`), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a claim close failure removes the claim instead of stranding the lock", () => {
  const { root, lockFile } = fixture();
  let closes = 0;
  try {
    assert.throws(
      () => acquireProcessLock(lockFile, {
        close: (fd) => {
          closes += 1;
          if (closes === 2) throw new Error("ticket close failed");
          closeSync(fd);
        },
      }),
      /ticket close failed/,
    );
    assert.equal(existsSync(lockFile), false);
    assert.deepEqual(readdirSync(`${lockFile}.claims`), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release removes the claim even when closing the projection descriptor fails", () => {
  const { root, lockFile } = fixture();
  let closes = 0;
  try {
    const lock = acquireProcessLock(lockFile, {
      close: (fd) => {
        closes += 1;
        if (closes === 3) throw new Error("projection close failed");
        closeSync(fd);
      },
    });
    lock.release();
    assert.equal(existsSync(lockFile), false);
    assert.deepEqual(readdirSync(`${lockFile}.claims`), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the refresh lock cannot be stolen from a live foreign owner", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "1\n");
    assert.throws(
      () => acquireRefreshLock(lockFile),
      /A Tweakers local refresh is already running \(PID 1\)/,
    );
    assert.equal(readFileSync(lockFile, "utf8"), "1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the refresh lock reclaims a dead owner's lock and releases it", () => {
  const { root, lockFile } = fixture();
  try {
    writeFileSync(lockFile, "999999\n");
    const lock = acquireRefreshLock(lockFile);
    assert.equal(Number.parseInt(readFileSync(lockFile, "utf8"), 10), process.pid);
    lock.release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local operations exclude siblings, permit nested steps, and retain interruption evidence", async () => {
  const { withLocalOperation, readLocalOperation } = await import("../src/local-operation.js");
  const { root } = fixture();
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { finish = resolve; });
  try {
    const first = withLocalOperation("build", async () => {
      await withLocalOperation("nested prerequisite", async () => {
        assert.equal(readLocalOperation(root)?.kind, "build");
      }, root);
      entered(); await hold;
    }, root);
    await ready;
    await assert.rejects(withLocalOperation("other build", async () => assert.fail("duplicate worker"), root, undefined, {wait:false}), /already running/);
    finish(); await first;
    assert.equal(readLocalOperation(root)?.state, "completed");
    writeFileSync(join(root, "operation.json"), JSON.stringify({version:1,id:"interrupted",pid:999999,kind:"candidate",state:"running"}));
    await assert.rejects(withLocalOperation("replacement", async () => assert.fail("recovery bypass"), root), /requires reconciliation/);
  } finally { finish?.(); rmSync(root, { recursive: true, force: true }); }
});

test("local artifact capacity counts retained vendor copies and refuses a third bundle", async () => {
  const { inspectLocalArtifactCapacity, assertLocalArtifactSlot, assertLocalExecutionPath } = await import("../src/local-artifacts.js");
  const { mkdirSync } = await import("node:fs");
  const { root } = fixture();
  const installed = join(root, "installed", "Tweakers.app");
  try {
    mkdirSync(installed, { recursive: true });
    assert.equal(inspectLocalArtifactCapacity(root, installed).occupied, 1);
    assert.doesNotThrow(() => assertLocalArtifactSlot(root, installed));
    mkdirSync(join(root, "official-source", "old", "ChatGPT.app"), { recursive: true });
    assert.equal(inspectLocalArtifactCapacity(root, installed).occupied, 2);
    assert.throws(() => assertLocalArtifactSlot(root, installed), /capacity blocked \(2\/2\)/);
    assert.doesNotThrow(() => assertLocalExecutionPath(installed));
    mkdirSync(join(root,"runtime","native","Tweakers Manager.app"),{recursive:true});
    assert.equal(inspectLocalArtifactCapacity(root,installed).occupied,2,"auxiliary Doctor is not a second desktop");
    mkdirSync(join(root,"renamed-preview.app"));
    assert.equal(inspectLocalArtifactCapacity(root,installed).occupied,3,"renaming a desktop cannot bypass admission");
    mkdirSync(join(root, "node_modules", "electron", "dist", "Electron.app"), {recursive:true});
    assert.equal(inspectLocalArtifactCapacity(root,installed).occupied,4,"vendor Electron bundles consume capacity");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal operation retention keeps newest 100 and recovery references", async () => {
  const {maintainTerminalOperationResults} = await import("../src/artifact-maintenance.js");
  const {root: temporary} = fixture();
  const root = realpathSync(temporary), trash = join(root,"Trash");
  try {
    mkdirSync(trash,{mode:0o700});
    for(let index=0;index<103;index++) {
      const id=`00000000-0000-0000-0000-${String(index).padStart(12,"0")}`;
      const record = {version:1,id,pid:1,kind:"test",
        startedAt:new Date(Date.UTC(2026,0,1,0,0,index)).toISOString(),state:"completed",
        ...(index===1?{transactionRef:"/recovery/needed"}:{})};
      writeFileSync(join(root,`result-${id}.json`),JSON.stringify(record),{mode:0o600});
      if(index===0)writeFileSync(join(root,"operation.json"),JSON.stringify(record),{mode:0o600});
    }
    const outcome=await maintainTerminalOperationResults(root,true,trash);
    assert.equal(outcome.retired.length,1);
    assert.ok(outcome.retired[0]?.endsWith("000000000002.json"));
    assert.equal(existsSync(join(root,"result-00000000-0000-0000-0000-000000000000.json")),true);
    assert.equal(existsSync(join(root,"result-00000000-0000-0000-0000-000000000001.json")),true);
    assert.equal(existsSync(outcome.retired[0]!),false);
    const receipt = JSON.parse(readFileSync(join(root,"retirement-receipts","00000000-0000-0000-0000-000000000002.json"),"utf8"));
    assert.equal(receipt.phase,"retired");
    assert.equal(receipt.original,outcome.retired[0]);
    assert.equal(existsSync(receipt.destination),true);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("interrupted operation reconciliation preserves failed evidence and refuses live ownership", async () => {
  const {reconcileInterruptedLocalOperation,readLocalOperation} = await import("../src/local-operation.js");
  const {root} = fixture();
  try {
    const file = join(root,"operation.json");
    writeFileSync(file, JSON.stringify({version:1,id:"abandoned",kind:"candidate",pid:999999,state:"running"}));
    await assert.rejects(reconcileInterruptedLocalOperation(root,"abandoned",async()=>{throw new Error("unfinished transaction");}),/unfinished transaction/);
    assert.equal(readLocalOperation(root)?.state,"running");
    await reconcileInterruptedLocalOperation(root,"abandoned",async()=>{});
    assert.equal(readLocalOperation(root)?.state,"failed");
    writeFileSync(file, JSON.stringify({version:1,id:"live",kind:"candidate",pid:process.pid,state:"running"}));
    await assert.rejects(reconcileInterruptedLocalOperation(root,"live",async()=>assert.fail("live owner recovery")),/live or unidentified/);
    writeFileSync(file,"{");
    assert.throws(()=>readLocalOperation(root));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("external candidate reservations consume a slot before and after publication", async () => {
  const { reserveLocalArtifact, inspectLocalArtifactCapacity,releaseEmptyLocalArtifactReservation } = await import("../src/local-artifacts.js");
  const { mkdirSync } = await import("node:fs");
  const { root } = fixture();
  const external = mkdtempSync(join(tmpdir(), "tweakers-external-candidate-"));
  const installed = join(root, "Tweakers.app"), candidate = join(external, "Tweakers.app");
  try {
    mkdirSync(installed);
    assert.throws(() => reserveLocalArtifact(root, installed, [candidate, installed]), /absent staging paths/);
    assert.equal(inspectLocalArtifactCapacity(root, installed).occupied, 1);
    const reservation=reserveLocalArtifact(root, installed, [candidate]);
    assert.equal(inspectLocalArtifactCapacity(root, installed).occupied, 2);
    assert.throws(() => reserveLocalArtifact(root, installed, [join(external,"third.app")]), /capacity blocked/);
    mkdirSync(candidate);
    assert.equal(inspectLocalArtifactCapacity(root, installed).occupied, 2);
    assert.throws(()=>releaseEmptyLocalArtifactReservation(root,reservation),/payload still exists/);
    rmSync(candidate,{recursive:true});
    releaseEmptyLocalArtifactReservation(root,reservation);
    assert.equal(inspectLocalArtifactCapacity(root,installed).occupied,1);
    const registry=JSON.parse(readFileSync(join(root,"local-artifact-reservations.json"),"utf8"));
    assert.equal(registry.reservations[0].state,"retired");
  } finally { rmSync(root,{recursive:true,force:true}); rmSync(external,{recursive:true,force:true}); }
});

test("deferred operation keeps ownership until its transaction settles", async () => {
  const { withLocalOperation, readLocalOperation } = await import("../src/local-operation.js");
  const { root } = fixture();
  let settle!: () => void;
  try {
    await withLocalOperation("promotion", async () => ({ provisional: true }), root, (_value, finish) => { settle = finish; return true; });
    assert.equal(readLocalOperation(root)?.state, "running");
    await assert.rejects(withLocalOperation("other", async () => {}, root, undefined, {wait:false}), /already running/);
    settle();
    assert.equal(readLocalOperation(root)?.state, "completed");
    await withLocalOperation("next", async () => {}, root);
  } finally { settle?.(); rmSync(root, {recursive:true,force:true}); }
});


test("operation waiters serialize and identical void requests attach", async () => {
  const { withLocalOperation } = await import("../src/local-operation.js");
  const { root } = fixture();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const options = {requestKey:"build:fixture",inputIdentity:"stable-input"};
  let workers = 0;
  try {
    const first = withLocalOperation("build",async()=>{ workers++; entered(); await hold; },root,undefined,options);
    await ready;
    const same = withLocalOperation("build",async()=>{workers++;},root,undefined,options);
    const abort = new AbortController();
    const cancelled = withLocalOperation("other",async()=>assert.fail("cancelled waiter ran"),root,undefined,{signal:abort.signal});
    abort.abort();
    await assert.rejects(cancelled);
    release(); await Promise.all([first,same]);
    assert.equal(workers,1);
    await withLocalOperation("next",async()=>{workers++;},root);
    assert.equal(workers,2);
  } finally {release?.();rmSync(root,{recursive:true,force:true});}
});

test("artifact generations follow promotion and rollback without hiding pending copies",async()=>{
  const {reserveLocalArtifact,inspectLocalArtifactCapacity,bindLocalArtifactPromotion,reconcileLocalArtifactPromotion,retireLocalArtifactAt}=await import("../src/local-artifacts.js");
  const {mkdirSync,renameSync}=await import("node:fs");
  const {root}=fixture();
  const installed=join(root,"Tweakers.app"),candidate=join(root,"candidate.app"),rollback=join(root,"previous.app"),failed=join(root,"failed.app");
  const fp=(path:string)=>({kind:"directory" as const,mode:0o755,sha256:readFileSync(join(path,"identity"),"utf8")});
  try {
    mkdirSync(installed);writeFileSync(join(installed,"identity"),"a".repeat(64));
    reserveLocalArtifact(root,installed,[candidate,failed]);
    mkdirSync(candidate);writeFileSync(join(candidate,"identity"),"b".repeat(64));
    const move={source:candidate,destination:installed,archive:rollback,failed,desired:fp(candidate),previous:fp(installed)};
    bindLocalArtifactPromotion(root,"transaction-1",move);
    assert.equal(inspectLocalArtifactCapacity(root,installed).occupied,2);
    renameSync(installed,rollback);renameSync(candidate,installed);
    reconcileLocalArtifactPromotion(root,"transaction-1",move,fp);
    assert.equal(inspectLocalArtifactCapacity(root,installed).occupied,2);
    // A failed cutover restores the old inode and preserves the failed generation.
    renameSync(installed,failed);renameSync(rollback,installed);
    reconcileLocalArtifactPromotion(root,"transaction-1",move,fp);
    assert.equal(inspectLocalArtifactCapacity(root,installed).occupied,2);
    assert.equal(fp(installed).sha256,"a".repeat(64));
    assert.throws(()=>reserveLocalArtifact(root,installed,[candidate]),/capacity blocked/);
    const receipt=join(root,"archive.json");writeFileSync(receipt,"{}");rmSync(failed,{recursive:true});
    retireLocalArtifactAt(root,failed,receipt);
    assert.equal(inspectLocalArtifactCapacity(root,installed).occupied,1);
    reserveLocalArtifact(root,installed,[candidate]);
    assert.equal(inspectLocalArtifactCapacity(root,installed).occupied,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});


test("source reverse moves deduplicate interrupted reservation aliases", async () => {
  const {reserveLocalArtifact, moveReservedLocalArtifact, inspectLocalArtifactCapacity} = await import("../src/local-artifacts.js");
  const {mkdirSync} = await import("node:fs");
  const {root} = fixture();
  const source=join(root,"source.app"), candidate=join(root,"candidate.app"), absent=join(root,"absent.app");
  try {
    reserveLocalArtifact(root,absent,[source]); mkdirSync(source);
    moveReservedLocalArtifact(root,source,candidate,[source,candidate]);
    moveReservedLocalArtifact(root,candidate,source,[source,candidate,source]);
    const snapshot=inspectLocalArtifactCapacity(root,absent);
    assert.equal(snapshot.occupied,1); assert.deepEqual(snapshot.blockers,[]);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("deferred interruption retains recovery state and removes signal listeners after settlement", async () => {
  const { withLocalOperation, readLocalOperation } = await import("../src/local-operation.js");
  const { root } = fixture();
  const abort = new AbortController();
  const listeners = process.listenerCount("SIGHUP");
  let settle!: () => void;
  try {
    await withLocalOperation("deferred", async () => undefined, root, (_value, finish) => { settle = finish; return true; }, {signal:abort.signal});
    assert.equal(process.listenerCount("SIGHUP"), listeners + 1);
    abort.abort();
    settle();
    assert.equal(process.listenerCount("SIGHUP"), listeners);
    assert.equal(readLocalOperation(root)?.state, "running");
    assert.equal(readLocalOperation(root)?.phase, "recovery-required");
    assert.match(readLocalOperation(root)?.error ?? "", /node scripts\/local-work.mjs recover/);
    await assert.rejects(withLocalOperation("next", async () => {}, root), /requires reconciliation/);
  } finally { settle?.(); rmSync(root, {recursive:true,force:true}); }
});

test("device identity recovery requires unchanged content and a committed journal", async () => {
  const { reconcileArtifactDeviceIdentities } = await import("../src/local-artifacts.js");
  const { lstatSync } = await import("node:fs");
  const { root } = fixture();
  try {
    const app = join(root,"Tweakers.app"), journal = join(root,"journal.json");
    mkdirSync(app);
    const st = lstatSync(app), seal = {kind:"directory",mode:0o755,sha256:"a".repeat(64)};
    writeFileSync(journal,JSON.stringify({phase:"committed",entries:[{name:"app",destination:app,desired:seal}]}));
    const registry = join(root,"local-artifact-reservations.json");
    const download = {id:"download",paths:[join(root,"download.app")],state:"reserved",operationId:"source-download"};
    writeFileSync(registry,JSON.stringify({version:1,reservations:[{id:"generation",paths:[app],state:"installed",transactionRef:journal,generationIdentity:{dev:st.dev+1,ino:st.ino},generationFingerprint:seal},download]}));
    assert.throws(()=>reconcileArtifactDeviceIdentities(root,()=>({...seal,sha256:"b".repeat(64)})),/seal or committed journal changed/);
    assert.deepEqual(reconcileArtifactDeviceIdentities(root,()=>seal),["generation"]);
    assert.equal(JSON.parse(readFileSync(registry,"utf8")).reservations[0].generationIdentity.dev,st.dev);
    assert.deepEqual(reconcileArtifactDeviceIdentities(root,()=>seal),[]);
    assert.deepEqual(JSON.parse(readFileSync(registry,"utf8")).reservations[1],download);
    const replaced=JSON.parse(readFileSync(registry,"utf8"));replaced.reservations[0].generationIdentity.ino+=1;
    writeFileSync(registry,JSON.stringify(replaced));
    assert.throws(()=>reconcileArtifactDeviceIdentities(root,()=>seal),/inode changed/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

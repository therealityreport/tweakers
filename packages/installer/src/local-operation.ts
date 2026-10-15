import { writeDoctorPrivateJson } from "./doctor-store.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { acquireProcessLock, processAlive, processIdentityAlive } from "./process-lock.js";

export interface LocalOperationRecord {
  version: 1; id: string; pid: number; kind: string; startedAt: string;
  processStartedAt?: string;
  state: "running" | "completed" | "failed"; error?: string;
  requestKey?: string; inputIdentity?: string; phase?: string;
  transactionRef?: string; resultRef?: string;
  children?:Array<{pid:number;processStartedAt:string;processGroup:number;command:string}>;
}
export interface LocalOperationOptions {
  /** Opt-in attachment is only valid for commands whose result is void. */
  requestKey?: string;
  inputIdentity?: string;
  signal?: AbortSignal;
  wait?: boolean;
  onWaiting?: (owner: Readonly<LocalOperationRecord> | null) => void;
}
function processStart(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {encoding:"utf8",timeout:2000});
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
const context = new AsyncLocalStorage<LocalOperationRecord>();
const operationRoots = new AsyncLocalStorage<string>();
export function userLocalOperationRoot():string {return join(userInfo().homedir,"Library","Application Support","Tweakers","local-operation");}
export function localOperationRoot(): string {
  return process.env.TWEAKERS_TEST_ROOT_PRELOAD === "active" && process.env.TWEAKERS_TEST_FALLBACK_ROOT
    ? join(process.env.TWEAKERS_TEST_FALLBACK_ROOT, "local-operation")
    : userLocalOperationRoot();
}
export function readLocalOperation(root = localOperationRoot()): LocalOperationRecord | null {
  try {
    const r = JSON.parse(readFileSync(join(root, "operation.json"), "utf8"));
    if (r.version !== 1 || typeof r.id !== "string" || !r.id || !Number.isSafeInteger(r.pid) || r.pid <= 0
      || typeof r.kind !== "string" || !["running", "completed", "failed"].includes(r.state)
      || (r.children !== undefined && (!Array.isArray(r.children) || !r.children.every((child: {pid:number;processGroup:number;processStartedAt:string;command:string}) =>
        Number.isSafeInteger(child.pid) && child.pid > 1 && child.processGroup === child.pid
        && typeof child.processStartedAt === "string" && child.processStartedAt.length > 0 && typeof child.command === "string")))) throw new Error("Malformed local operation record; reconcile before starting work");
    return r;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function publish(root: string, record: LocalOperationRecord): void {
  writeDoctorPrivateJson(join(realpathSync(root),"operation.json"),record);
}
function inherited(record: LocalOperationRecord | null): boolean {
  if (!record || record.state !== "running" || record.id !== process.env.TWEAKERS_LOCAL_OPERATION_ID || !processAlive(record.pid)
    || !record.processStartedAt || processStart(record.pid) !== record.processStartedAt) return false;
  // An environment value alone is not ownership. Require a live ancestor.
  let pid = process.ppid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    if (pid === record.pid) return true;
    const observed = spawnSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", timeout: 2000 });
    if (observed.status !== 0) return false;
    pid = Number(observed.stdout.trim());
  }
  return false;
}
/** Detached follow-up work must acquire its own lease, never borrow a finished one. */
export function outsideLocalOperationContext<T>(run: () => T): T {
  return context.exit(() => operationRoots.exit(run));
}
export function hasInheritedLocalOperation(root=localOperationRoot()): boolean {
  return !!context.getStore() || inherited(readLocalOperation(root));
}
/** Shared across checkouts; nested steps inherit only from a verified live owner. */
export async function withLocalOperation<T>(kind: string, work: () => Promise<T>, root = localOperationRoot(), retain?: (result: T, settle: () => void) => boolean, options: LocalOperationOptions = {}): Promise<T> {
  if (context.getStore() || inherited(readLocalOperation(root))) return withLocalOperationOwned(kind, work, root, retain, options);
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Tweakers operation interrupted"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, interrupted);
  let deferred = false;
  const cleanup = () => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, interrupted);
  };
  try {
    const result = await withLocalOperationOwned(kind, work, root, retain ? (result, settle) => {
      let settled = false;
      deferred = retain(result, () => { settle(); settled = true; cleanup(); }) && !settled;
      return deferred;
    } : undefined, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
    if (!deferred && root === userLocalOperationRoot() && (kind === "direct official update" || kind.startsWith("doctor:"))) {
      try {
        const { maintainTerminalOperationResults } = await import("./artifact-maintenance.js");
        await maintainTerminalOperationResults(root, true);
      } catch (error) {
        // Updating succeeded; retention failure must remain visible without
        // relabeling the completed update as a failed application cutover.
        const message = error instanceof Error ? error.message : String(error);
        writeDoctorPrivateJson(join(realpathSync(root), "retention-error.json"), {version:1,kind,error:message,at:new Date().toISOString()});
        console.warn(`Tweakers terminal record retention requires attention: ${message}`);
      }
    }
    return result;
  } finally {
    if (!deferred) cleanup();
  }
}

async function withLocalOperationOwned<T>(kind: string, work: () => Promise<T>, root: string, retain: ((result: T, settle: () => void) => boolean) | undefined, options: LocalOperationOptions): Promise<T> {
  if (context.getStore()) return work();
  const parent = readLocalOperation(root);
  if (inherited(parent)) return operationRoots.run(root,()=>context.run(parent!, work));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let lock: ReturnType<typeof acquireProcessLock>;
  let attached: LocalOperationRecord | null = null;
  let announced: string | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    if (attached) {
      try {
        const terminal = JSON.parse(readFileSync(join(root, `result-${attached.id}.json`), "utf8")) as LocalOperationRecord;
        if (terminal.id !== attached.id || terminal.requestKey !== options.requestKey || terminal.inputIdentity !== options.inputIdentity) throw new Error("Attached operation identity changed");
        if (terminal.state === "completed") return undefined as T;
        if (terminal.state === "failed") throw new Error(terminal.error ?? "Attached operation failed");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    let contention = false;
    try {
      lock = acquireProcessLock(join(root, "operation.lock"), { onContended: () => {
        contention = true;
        return new Error(`Tweakers work is already running: ${readLocalOperation(root)?.kind ?? "unknown operation"}. Wait for its owner; no duplicate worker was started.`);
      }});
      break;
    } catch (error) {
      if (!contention || options.wait === false) throw error;
      const owner = readLocalOperation(root);
      if (!owner || owner.state !== "running" || !owner.processStartedAt || !processIdentityAlive(owner.pid, owner.processStartedAt)) throw new Error(`Interrupted or unidentified Tweakers operation requires reconciliation. Run: node scripts/local-work.mjs recover ${owner?.id ?? "<operation-id>"}`);
      if (options.requestKey && options.inputIdentity && owner.requestKey === options.requestKey && owner.inputIdentity === options.inputIdentity) attached = owner;
      if (announced !== owner.id) { options.onWaiting?.(owner); announced = owner.id; }
      await new Promise<void>((done) => setTimeout(done, 250));
    }
  }
  if (attached) {
    // The owner may have completed between the result read and acquisition.
    // Attachment never turns into permission to run a duplicate worker.
    try {
      const result = JSON.parse(readFileSync(join(root, `result-${attached.id}.json`), "utf8")) as LocalOperationRecord;
      if (result.id !== attached.id || result.requestKey !== options.requestKey || result.inputIdentity !== options.inputIdentity) throw new Error("Attached operation identity changed");
      if (result.state !== "completed") throw new Error(result.error ?? "Attached operation requires reconciliation");
      return undefined as T;
    } finally { lock.release(); }
  }
  let old: LocalOperationRecord | null;
  try { old = readLocalOperation(root); } catch (error) { lock.release(); throw error; }
  // A dead owner may have left a candidate/transaction. Do not silently resume it.
  try {
  if (old?.state === "running") {
    if (old.processStartedAt && !processIdentityAlive(old.pid, old.processStartedAt) && !old.transactionRef
      && !(old.children ?? []).some(child => processIdentityAlive(child.pid, child.processStartedAt) || localOperationProcessGroupAlive(child.processGroup))) {
      publish(root, { ...old, state: "failed", phase: "reconciled", error: "Abandoned owner reconciled; retained artifacts were not retried" });
    } else {
      lock.release();
      throw new Error(`Interrupted Tweakers operation ${old.id} requires reconciliation. Run: node scripts/local-work.mjs recover ${old.id}`);
    }
  }
  } catch (error) { lock.release(); throw error; }
  const processStartedAt = processStart(process.pid);
  if (!processStartedAt) { lock.release(); throw new Error("Cannot establish local operation process identity"); }
  const record: LocalOperationRecord = { version: 1, id: randomUUID(), pid: process.pid, processStartedAt, kind, startedAt: new Date().toISOString(), state: "running", phase: "executing", requestKey: options.requestKey, inputIdentity: options.inputIdentity };
  const terminal = (state: "completed" | "failed", error?: string) => {
    const resultRef = join(root, `result-${record.id}.json`);
    const result = { ...record, state, phase: state, error, resultRef };
    writeDoctorPrivateJson(join(realpathSync(root),`result-${record.id}.json`),result);
    publish(root, result);
  };
  const previous = process.env.TWEAKERS_LOCAL_OPERATION_ID;
  let retained = false;
  try {
    publish(root, record);
    process.env.TWEAKERS_LOCAL_OPERATION_ID = record.id;
    const result = await operationRoots.run(root,()=>context.run(record, work));
    options.signal?.throwIfAborted();
    if (options.requestKey && result !== undefined) throw new Error("Attachable operations must return void; use a durable result reference for non-void work");
    let settled = false;
    const settle = () => {
      if (settled) return;
      if (readLocalOperation(root)?.id !== record.id) throw new Error("Local operation ownership changed before settlement");
      if (options.signal?.aborted) {
        publish(root, { ...record, phase: "recovery-required", error: `Operation interrupted during settlement. Run: node scripts/local-work.mjs recover ${record.id}` });
      } else terminal("completed");
      settled = true; lock.release();
    };
    retained = retain?.(result, settle) ?? false;
    if (!retained) terminal("completed");
    return result;
  } catch (error) {
    if (options.signal?.aborted || record.transactionRef || record.children?.length || (error as { requiresReconciliation?: boolean })?.requiresReconciliation) publish(root, { ...record, phase: "recovery-required", error: `${error instanceof Error ? error.message : "operation failed"}. Run: node scripts/local-work.mjs recover ${record.id}` });
    else terminal("failed", error instanceof Error ? error.message : "operation failed");
    throw error;
  } finally {
    if (previous === undefined) delete process.env.TWEAKERS_LOCAL_OPERATION_ID; else process.env.TWEAKERS_LOCAL_OPERATION_ID = previous;
    if (!retained) lock.release();
  }
}

/** No automatic retry: callers must reconcile durable transactions and workers first. */
export async function reconcileInterruptedLocalOperation(root: string, expectedID: string,
  verifyTransactionState: (record: Readonly<LocalOperationRecord>) => Promise<void>): Promise<void> {
  const lease = acquireProcessLock(join(root, "operation.lock"));
  try {
    const record = readLocalOperation(root);
    if (!record || record.id !== expectedID || record.state !== "running") throw new Error("Interrupted operation identity changed");
    if (processIdentityAlive(record.pid, record.processStartedAt)) throw new Error("Cannot recover a live or unidentified operation owner");
    for(const child of record.children??[]) {
      const groupAlive=localOperationProcessGroupAlive(child.processGroup);
      if(groupAlive || (processAlive(child.pid)&&processStart(child.pid)===child.processStartedAt))throw new Error("Owned operation descendants remain alive; recovery cannot release ownership");
    }
    await verifyTransactionState(record);
    const fresh = readLocalOperation(root);
    if (!fresh || fresh.id !== expectedID || fresh.state !== "running" || processIdentityAlive(record.pid, record.processStartedAt)) throw new Error("Operation changed during recovery");
    publish(root, {...record,state:"failed",error:"Interrupted execution reconciled; no automatic retry was started"});
  } finally { lease.release(); }
}


export function updateLocalOperationPhase(phase:string,transactionRef?:string):void {
  const record=context.getStore(),root=operationRoots.getStore();
  if(!record||!root)return;
  if(readLocalOperation(root)?.id!==record.id)throw new Error("Operation changed before phase publication");
  record.phase=phase;if(transactionRef!==undefined)record.transactionRef=transactionRef;
  publish(root,record);
}


export function recordLocalOperationChild(pid:number,command:string,finished=false):void {
  const record=context.getStore(),root=operationRoots.getStore();if(!record||!root)return;
  if(readLocalOperation(root)?.id!==record.id)throw new Error("Operation changed while recording its worker");
  record.children=(record.children??[]).filter(child=>child.pid!==pid);
  if(!finished){const started=processStart(pid);if(started)record.children.push({pid,processStartedAt:started,processGroup:pid,command});}
  publish(root,record);
}

/** Explicit recovery owns the lease throughout inspection and journal reconciliation. */
export async function recoverInterruptedTweakersOperation(expectedID: string): Promise<void> {
  const operationRoot = userLocalOperationRoot();
  const root = join(operationRoot, "..");
  const { resolve } = await import("node:path");
  const canonicalRoot = resolve(root);
  await reconcileInterruptedLocalOperation(operationRoot, expectedID, async record => {
    const artifacts = await import("./local-artifacts.js");
    const before = artifacts.inspectLocalArtifactCapacity(canonicalRoot);
    if (before.blockers.length) throw new Error(before.blockers.join("; "));
    const variantRoot = join(canonicalRoot, "variants/tweakers");
    let transactionID: string | undefined;
    if (record.transactionRef) {
      transactionID = record.transactionRef.split("/").at(-1)?.replace(/\.json$/, "");
      if (!transactionID || !/^[a-f0-9-]{36}$/.test(transactionID)
        || record.transactionRef !== join(variantRoot, "transactions/variant-promotion", transactionID + ".json")
        || !existsSync(record.transactionRef)) throw new Error("Operation transaction requires its exact owning journal");
    }
    const { recoverInterruptedTweakersVariantPromotions } = await import("./commands/create-variant.js");
    const variantLock = acquireProcessLock(join(variantRoot, "transactions/variant-promotion.lock"));
    try {
      if (transactionID) recoverInterruptedTweakersVariantPromotions(variantRoot, "/Applications/Tweakers.app", { managerRoot: () => canonicalRoot }, transactionID);
    } finally { variantLock.release(); }
    const { reconcilePreparedSourceConsumption } = await import("./official-source-registration.js");
    if (existsSync(join(canonicalRoot, "official-source/current-evidence.json"))) reconcilePreparedSourceConsumption(canonicalRoot);
    await (await import("./artifact-retirement.js")).reconcileVerifiedRollbackRetirements(canonicalRoot);
    for (const reservation of artifacts.readReservations(canonicalRoot)) {
      if (reservation.operationId !== record.id || reservation.state === "retired") continue;
      if (reservation.ownerPid !== record.pid || reservation.ownerStartedAt !== record.processStartedAt) throw new Error("Reservation owner identity changed");
      if (!reservation.paths.some(existsSync)) {
        if (reservation.state !== "reserved" || reservation.transactionRef) throw new Error("Missing generation requires transaction recovery evidence");
        artifacts.releaseEmptyLocalArtifactReservation(canonicalRoot, reservation.id);
      }
      // Existing partial generations retain their slot. Recovery permits
      // inspection/repair, never a duplicate construction retry.
    }
    artifacts.publishLocalArtifactSnapshot(canonicalRoot, artifacts.inspectLocalArtifactCapacity(canonicalRoot));
  });
}

/** ps distinguishes a vanished group from an indeterminate signal-permission result. */
export function localOperationProcessGroupAlive(group: number): boolean {
  if (!Number.isSafeInteger(group) || group < 2) throw new Error("Invalid operation process group");
  const result = spawnSync("/bin/ps", ["-axo", "pgid="], { encoding: "utf8", timeout: 2000 });
  if (result.status !== 0) throw new Error("Cannot verify operation descendants");
  return result.stdout.split("\n").some(line => Number(line.trim()) === group);
}

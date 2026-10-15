import { writeDoctorPrivateJson } from "./doctor-store.js";
import { readLocalOperation } from "./local-operation.js";
import { randomUUID } from "node:crypto";
import { acquireProcessLock } from "./process-lock.js";
import { existsSync, lstatSync, readdirSync, realpathSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface LocalArtifactCapacity {
  limit: 2; occupied: number; paths: string[]; blockers: string[];
}
/** Status reads a bounded snapshot. Admission always performs a fresh inventory. */
export function readLocalArtifactSnapshot(root: string): (LocalArtifactCapacity & { sampledAt: string }) | null {
  try {
    const value = JSON.parse(readFileSync(join(root, "local-artifact-snapshot.json"), "utf8"));
    return value.limit === 2 && Number.isSafeInteger(value.occupied) && Array.isArray(value.paths)
      && Array.isArray(value.blockers) && typeof value.sampledAt === "string" ? value : null;
  } catch { return null; }
}
export function publishLocalArtifactSnapshot(root: string, capacity: LocalArtifactCapacity): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `artifact-snapshot-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ ...capacity, sampledAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(root, "local-artifact-snapshot.json"));
}
/** Read-only inventory. Never follows symlinks or descends into app bundles/user data. */
export function inspectLocalArtifactCapacity(root = join(homedir(), "Library", "Application Support", "Tweakers"), installed = "/Applications/Tweakers.app"): LocalArtifactCapacity {
  const paths = new Set<string>(), blockers: string[] = [];
  let reservedSlots=0;
  const add = (path: string) => { if (existsSync(path)) paths.add(resolve(path)); };
  add(installed);
  const ignored = new Set([".git", "codex-home", "app-data", "tweak-data", "artifact-archives", "sessions", "credentials", "plugin-generations", "shared-account-config"]);
  const walk = (path: string, depth: number): void => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { if (path.endsWith(".app")) blockers.push(`Unresolved artifact symlink: ${path}`); return; }
    if (!stat.isDirectory()) return;
    if (depth > 64) { blockers.push(`Inventory depth exceeded: ${path}`); return; }
    if (path.endsWith(".app")) {
      // Renaming a desktop does not exempt it. Only known auxiliary app names
      // are excluded; a main app is counted once with its embedded helpers.
      if (!/^(?:Tweakers Manager|Tweakers Doctor|Tweakers Swap Helper|Tweakers App Launcher|Tweakers Manager Launcher|Tweakers Switcher)\.app$/.test(basename(path))) add(path);
      return;
    }
    for (const name of readdirSync(path)) if (!ignored.has(name)) walk(join(path, name), depth + 1);
  };
  try {
    walk(root, 0);
    if (resolve(root) === join(homedir(), "Library", "Application Support", "Tweakers")) {
      try {
        const development=JSON.parse(readFileSync(join(root,"refresh-state.json"),"utf8")).developmentSourceRoot;
        if(typeof development==="string"&&existsSync(development)) {
          const checkout=realpathSync(development);
          if(checkout!==realpathSync(root)) {
            // Development registration gives us a checkout, not permission to
            // enumerate every source file and dependency on each admission.
            // These are the build/vendor roots that can contain desktop copies.
            for (const relative of [
              "dist", "build", "out", ".cache", "node_modules/electron/dist",
              "packages/installer/dist", "packages/installer/build", "packages/installer/out",
              "packages/installer/node_modules/electron/dist", "packages/runtime/dist",
              "packages/runtime/node_modules/electron/dist", "packages/installer/assets/runtime/native",
            ]) walk(join(checkout, relative), 0);
          }
        }
      }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")blockers.push("Development artifact inventory unavailable");}
      const caches = join(homedir(), "Library", "Caches");
      if (existsSync(caches)) for (const name of readdirSync(caches)) if (/^(?:tweakers|codex-plusplus)[-_.]/i.test(name)) walk(join(caches, name), 0);
    }
    // Adjacent atomic staging is outside the support root.
    const parent = resolve(installed, "..");
    if (existsSync(parent)) for (const name of readdirSync(parent)) {
      if (name.startsWith(`.${basename(installed)}.candidate-`) && name.endsWith(".app")) add(join(parent, name));
    }
  } catch (error) { blockers.push(`Artifact inventory unavailable: ${error instanceof Error ? error.message : "unknown"}`); }
  try {
    const claimed=new Set<string>();
    for (const entry of readReservations(root)) {
      if(entry.state === "retired") {
        if(entry.missingRecovery&&entry.paths.some(existsSync))blockers.push(`Retired recovery payload reappeared: ${entry.id}`);
        continue;
      }
      const present = entry.paths.filter(path=>existsSync(path)&&(!entry.generationIdentity||sameFileIdentity(path,entry.generationIdentity))).map(resolvePath);
      // Reservations represent generations, not destination names. An empty
      // reservation still consumes its slot; two reservations cannot collapse.
      reservedSlots += Math.max(1,present.length);
      if(entry.missingRecovery && entry.paths.some(existsSync)) {
        // Once recovery is bound, a returning historical path is a separate
        // payload even when its old inode still matches. Never collapse it.
        blockers.push(`Historical payload reappeared during recovery: ${entry.id}`);
        if(present.length)reservedSlots++;
      }
      for(const path of present) {
        if(claimed.has(path))blockers.push(`Multiple generations claim ${path}`);
        claimed.add(path);paths.delete(path);
      }
    }
    const unclaimed=[...paths];
    for(const entry of readReservations(root))if(entry.state!=="retired")for(const path of entry.paths.filter(path=>existsSync(path)&&(!entry.generationIdentity||sameFileIdentity(path,entry.generationIdentity))))paths.add(resolve(path));
    for(const entry of readReservations(root))if(entry.state!=="retired"&&!entry.paths.some(existsSync))paths.add(entry.paths[0]!);
    return {limit:2,occupied:unclaimed.length+reservedSlots,paths:[...paths].sort(),blockers};
  } catch { blockers.push("Artifact reservation registry is unreadable"); }
  return { limit: 2, occupied: paths.size, paths: [...paths].sort(), blockers };
}
export function assertLocalArtifactSlot(root?: string, installed?: string): void {
  const capacity = inspectLocalArtifactCapacity(root, installed);
  if (root) publishLocalArtifactSnapshot(root, capacity);
  if (capacity.blockers.length || capacity.occupied >= capacity.limit) throw new Error(
    `Local build capacity blocked (${capacity.occupied}/${capacity.limit}). Reconcile and archive existing builds before staging another. ${capacity.blockers.join("; ")} ${capacity.paths.join("; ")}`);
}

/** Reconcile only an allocation which has no remaining payload at any recorded path. */
export function releaseEmptyLocalArtifactReservation(root: string, id: string): void {
  const lease = acquireProcessLock(join(root, "local-artifacts.lock"));
  try {
    const entries = readReservations(root);
    const entry = entries.find(r => r.id === id);
    if (!entry) return;
    if (entry.missingRecovery) throw new Error("Missing artifact recovery requires its validated successor receipt");
    if (entry.paths.some(existsSync)) throw new Error("Cannot release an artifact reservation while its payload still exists");
    publishReservations(root, entries.map(r => r.id === id ? {...r,state:"retired"} : r));
  } finally { lease.release(); }
}
export function assertLocalExecutionPath(path: string): void {
  const actual = realpathSync(path);
  if (actual === "/Volumes/SHOWS DB" || actual.startsWith("/Volumes/SHOWS DB/")
    || /^\/Volumes\/Tweakers(?:ArchiveVerify-|ManagerRestoreCheck(?:\/|$)|RestoreCheck(?:\/|$))/.test(actual)) throw new Error("Archive storage cannot execute Tweakers or provide active runtime dependencies");
}

export interface ArtifactReservation {
  id: string; paths: string[];
  state?: "reserved" | "partial" | "candidate" | "installed" | "rollback" | "retired";
  operationId?: string; ownerPid?: number; ownerStartedAt?: string;
  transactionRef?: string; retiredReceipt?: string;
  generationIdentity?:{dev:number;ino:number};
  generationFingerprint?:{kind:string;mode:number;sha256:string};
  /** A restoration is the same occupied allocation, never a second generation. */
  missingRecovery?: { transactionId: string; manifest: string; manifestSHA256: string;
    proof: { kind: "private-apfs-verification-image"; image: string; mount: string } };
}
const resolvePath=(path:string)=>resolve(path);
function sameFileIdentity(path:string,identity:{dev:number;ino:number}):boolean {const st=lstatSync(path);return !st.isSymbolicLink()&&st.dev===identity.dev&&st.ino===identity.ino;}
/** Called after a journaled rename. Preserve the slot as the same generation moves. */
export function relocateLocalArtifactReservation(root: string, previous: string, destination: string): void {
  const lease = acquireProcessLock(join(root, "local-artifacts.lock"));
  try {
    if (existsSync(previous) || !existsSync(destination)) throw new Error("Artifact relocation has not completed");
    const entries = readReservations(root).map(entry => entry.paths.includes(resolve(previous))
      ? { ...entry, paths:[resolve(destination)],state: destination === "/Applications/Tweakers.app" ? "installed" as const : "candidate" as const } : entry);
    publishReservations(root, entries);
  } finally { lease.release(); }
}
export function readReservations(root: string): ArtifactReservation[] {
  const file = join(root, "local-artifact-reservations.json");
  if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.version !== 1 || !Array.isArray(value.reservations) || !value.reservations.every((r: ArtifactReservation) =>
    typeof r.id === "string" && (r.state===undefined||["reserved","partial","candidate","installed","rollback","retired"].includes(r.state)) && Array.isArray(r.paths) && r.paths.length > 0 && r.paths.every(p => typeof p === "string" && resolve(p) === p))) throw new Error("Invalid artifact registry");
  for(const entry of value.reservations as ArtifactReservation[])if(entry.missingRecovery) {
    const recovery=entry.missingRecovery,uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
    if(!uuid.test(recovery.transactionId)||! /^[a-f0-9]{64}$/.test(recovery.manifestSHA256)
      ||recovery.manifest!==join(root,"artifact-archives/missing-artifact-recovery",recovery.transactionId,"input.json")
      ||recovery.proof?.kind!=="private-apfs-verification-image"
      ||recovery.proof.image!==join("/Volumes/SHOWS DB/_Mac-Archive/Tweakers/failed-promotions",`${recovery.transactionId}.missing-restore.sparseimage`)
      ||recovery.proof.mount!==join("/Volumes",`TweakersArchiveVerify-${recovery.transactionId}`))throw new Error("Invalid artifact recovery allocation");
  }
  return value.reservations;
}
/** Reserve all possible paths of one generation before allocating any staging. */
export function reserveLocalArtifact(root: string, installed: string, paths: string[]): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lease = acquireProcessLock(join(root, "local-artifacts.lock"));
  try {
    const destinations = [...new Set(paths.map(p => resolve(p)))];
    if (!destinations.length || destinations.some(existsSync)) {
      throw new Error("A new artifact reservation requires absent staging paths; an existing installation cannot cover a future copy");
    }
    assertLocalArtifactSlot(root, installed);
    const prior=readReservations(root);
    if(prior.some(entry=>entry.state!=="retired"&&entry.paths.some(p=>destinations.includes(p))))throw new Error("Artifact destination is already reserved by another generation");
    const id = randomUUID(),owner=readLocalOperation();
    const reservations = [...prior, { id, paths: destinations,state:"reserved" as const,operationId:owner?.id,ownerPid:owner?.pid,ownerStartedAt:owner?.processStartedAt }];
    publishReservations(root, reservations);
    return id;
  } finally { lease.release(); }
}

/** Consume one reserved generation by rename. The journal survives either side of a crash. */
export function moveReservedLocalArtifact(root:string,source:string,destination:string,remainingPaths:string[]=[],installed="/Applications/Tweakers.app"):void {
  const lease=acquireProcessLock(join(root,"local-artifacts.lock"));
  try {
    const entries=readReservations(root),entry=entries.find(e=>e.state!=="retired"&&e.paths.includes(resolve(source)));
    if(!entry||!existsSync(source)||existsSync(destination))throw new Error("Reserved source move is not admissible");
    assertLocalExecutionPath(source);assertLocalExecutionPath(resolve(destination,".."));
    const capacity=inspectLocalArtifactCapacity(root,installed);
    if(capacity.blockers.length||capacity.occupied>2)throw new Error("Artifact capacity requires reconciliation before move");
    const publish=()=>publishReservations(root, entries);
    entry.state="partial";entry.paths=[...new Set([resolve(source),resolve(destination),...remainingPaths.map(resolvePath)])];publish();
    renameSync(source,destination);
    entry.paths=[...new Set([resolve(destination),...remainingPaths.map(resolvePath)])];publish();
  }finally{lease.release();}
}


interface PromotionArtifactMove {source:string;destination:string;archive:string;failed:string;desired:{kind:string;mode:number;sha256:string};previous:{kind:string;mode:number;sha256:string}|null;}
function publishReservations(root:string,reservations:ArtifactReservation[]):void {
  writeDoctorPrivateJson(join(realpathSync(root),"local-artifact-reservations.json"), {version:1,reservations});
}

/** Full-record CAS: a missing payload never releases capacity by itself. */
export function bindMissingArtifactRecovery(root:string, prior:ArtifactReservation,
  recovery:NonNullable<ArtifactReservation["missingRecovery"]>):ArtifactReservation {
  const lease=acquireProcessLock(join(root,"local-artifacts.lock"));
  try {
    const entries=readReservations(root),index=entries.findIndex(entry=>entry.id===prior.id);
    if(index<0 || JSON.stringify(entries[index])!==JSON.stringify(prior) || prior.state!=="partial"
      || prior.missingRecovery || prior.paths.some(existsSync)) throw new Error("Missing artifact reservation changed before allocation");
    if(entries.some(entry=>entry.missingRecovery?.proof.image===recovery.proof.image)) throw new Error("Recovery image already allocated");
    const bound={...prior,missingRecovery:recovery};entries[index]=bound;publishReservations(root,entries);return bound;
  } finally {lease.release();}
}

/** The caller must validate the successor and live disposition while all admission locks are held. */
export function reconcileMissingArtifactRecovery(root:string, expected:ArtifactReservation, receipt:string,
  validate:()=>void):void {
  const lease=acquireProcessLock(join(root,"local-artifacts.lock"));
  try {
    const entries=readReservations(root),index=entries.findIndex(entry=>entry.id===expected.id);
    if(index<0 || JSON.stringify(entries[index])!==JSON.stringify(expected) || !expected.missingRecovery
      || expected.state!=="partial" || expected.paths.some(existsSync)) throw new Error("Recovery reservation changed before reconciliation");
    validate();entries[index]={...expected,state:"retired",retiredReceipt:receipt};publishReservations(root,entries);
  } finally {lease.release();}
}
/** Persist generation identity before the promotion journal can move either app. */
export function bindLocalArtifactPromotion(root:string,transactionRef:string,move:PromotionArtifactMove):void {
  const lease=acquireProcessLock(join(root,"local-artifacts.lock"));
  try {
    const entries=readReservations(root);
    const bind=(path:string,paths:string[],fingerprint:NonNullable<PromotionArtifactMove["previous"]>,state:"candidate"|"installed")=>{
      const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("Promotion artifact identity is unsafe");
      const existing=entries.filter(e=>e.state!=="retired"&&e.paths.includes(path)&&(!e.generationIdentity||sameFileIdentity(path,e.generationIdentity)));
      if(existing.length>1)throw new Error("Multiple reservations own the promotion generation");
      const entry=existing[0]??{id:randomUUID(),paths:[]};if(!existing.length)entries.push(entry);
      Object.assign(entry,{paths,state,transactionRef,generationIdentity:{dev:stat.dev,ino:stat.ino},generationFingerprint:fingerprint});
    };
    // Bind the installed entry first, before the candidate gains its target alias.
    if(move.previous)bind(move.destination,[move.destination,move.archive],move.previous,"installed");
    bind(move.source,[move.source,move.destination,move.failed],move.desired,"candidate");
    publishReservations(root,entries);
  }finally{lease.release();}
}
/** Reconcile only identity- and content-proven journal locations, never a dead PID alone. */
export function reconcileLocalArtifactPromotion(root:string,transactionRef:string,move:PromotionArtifactMove,fingerprint:(path:string)=>PromotionArtifactMove["desired"]):void {
  const lease=acquireProcessLock(join(root,"local-artifacts.lock"));
  try {
    const entries=readReservations(root);
    for(const entry of entries.filter(e=>e.transactionRef===transactionRef&&e.state!=="retired")) {
      if(!entry.generationIdentity||!entry.generationFingerprint)throw new Error("Promotion reservation has no generation identity");
      const present=[...new Set([...entry.paths,move.source,move.destination,move.archive,move.failed])].filter(path=>existsSync(path)&&sameFileIdentity(path,entry.generationIdentity!));
      if(present.length!==1||JSON.stringify(fingerprint(present[0]!))!==JSON.stringify(entry.generationFingerprint))throw new Error("Promotion artifact requires explicit recovery; no reservation was released");
      const path=present[0]!;entry.paths=[path];entry.state=path===move.destination?"installed":path===move.archive?"rollback":path===move.failed?"partial":"candidate";
    }
    publishReservations(root,entries);
  }finally{lease.release();}
}


export function retireLocalArtifactAt(root:string,path:string,receipt:string):void {
  const lease=acquireProcessLock(join(root,"local-artifacts.lock"));
  try {
    if(existsSync(path)||!existsSync(receipt))throw new Error("Retirement requires an absent payload and durable archive receipt");
    const entries=readReservations(root);
    for(const entry of entries)if(entry.state!=="retired"&&entry.paths.includes(path)){
      if(entry.missingRecovery)throw new Error("Missing artifact recovery requires its validated successor receipt");
      if(entry.paths.some(existsSync))throw new Error("Retired generation still has a local payload");
      entry.state="retired";entry.retiredReceipt=receipt;
    }
    publishReservations(root,entries);
  }finally{lease.release();}
}

/** Explicit recovery for a remounted filesystem; never infer identity from inode alone. */
export function reconcileArtifactDeviceIdentities(
  root: string, fingerprint: (path: string) => NonNullable<ArtifactReservation["generationFingerprint"]>,
  verifyMetadataRepair?: (path: string, original: NonNullable<ArtifactReservation["generationFingerprint"]>) => NonNullable<ArtifactReservation["generationFingerprint"]>,
): string[] {
  const lease = acquireProcessLock(join(root, "local-artifacts.lock"));
  try {
    const entries = readReservations(root);
    const changes: Array<{id:string;path:string;before:{dev:number;ino:number};after:{dev:number;ino:number}}> = [];
    for (const entry of entries.filter(row => row.state !== "retired")) {
      // A download/candidate without a recorded device identity is unrelated to
      // remount recovery. Preserve its reservation and capacity claim unchanged.
      if(!entry.generationIdentity) continue;
      if(entry.paths.length===1&&existsSync(entry.paths[0]!)&&sameFileIdentity(entry.paths[0]!,entry.generationIdentity))continue;
      if (entry.paths.length !== 1 || !entry.generationIdentity || !entry.generationFingerprint
        || !entry.transactionRef || !["installed", "rollback"].includes(entry.state ?? "")) throw new Error("Artifact identity recovery requires a terminal installed/rollback reservation");
      const path = entry.paths[0]!, before = lstatSync(path);
      if (before.isSymbolicLink() || !before.isDirectory() || before.ino !== entry.generationIdentity.ino) throw new Error("Artifact inode changed; manual recovery required");
      const journalText = readFileSync(entry.transactionRef, "utf8");
      const journal = JSON.parse(journalText);
      const app = journal.entries?.find((item: {name:string}) => item.name === "app");
      const expected = entry.state === "installed" ? app?.desired : app?.previous;
      const expectedPath = entry.state === "installed" ? app?.destination : app?.archive;
      if (journal.phase !== "committed" || expectedPath !== path
        || JSON.stringify(expected) !== JSON.stringify(entry.generationFingerprint)) throw new Error("Artifact seal or committed journal changed; manual recovery required");
      const actual = fingerprint(path);
      if (JSON.stringify(actual) !== JSON.stringify(entry.generationFingerprint)
        && (!verifyMetadataRepair || entry.state !== "installed"
          || JSON.stringify(verifyMetadataRepair(path, expected)) !== JSON.stringify(actual))) throw new Error("Artifact seal or committed journal changed; manual recovery required");
      const after = lstatSync(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs
        || readFileSync(entry.transactionRef, "utf8") !== journalText) throw new Error("Artifact changed during identity recovery");
      changes.push({id:entry.id,path,before:entry.generationIdentity,after:{dev:after.dev,ino:after.ino}});
    }
    if (changes.length) {
      const receipt = join(realpathSync(root), "artifact-archives", "identity-reconciliation", `${randomUUID()}.json`);
      writeDoctorPrivateJson(receipt, {version:1,reason:"Committed tree seals and inode verified after device identity change",changes});
      for (const change of changes) {
        const current = lstatSync(change.path);
        if (current.dev !== change.after.dev || current.ino !== change.after.ino) throw new Error("Artifact changed before identity publication");
        entries.find(entry=>entry.id===change.id)!.generationIdentity = change.after;
      }
      publishReservations(root, entries);
    }
    return changes.map(change=>change.id);
  } finally { lease.release(); }
}

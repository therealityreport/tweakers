import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmdirSync, statSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export interface StoreTransactionOptions {
  tweaksDir: string;
  id: string;
  prepare(stagingDir: string): void | Promise<void>;
  /** Owns catalog/manifest/approval metadata policy; reject unknown or changed metadata. */
  assertUnchanged(target: string): void | Promise<void>;
  /** A fulfilled lifecycle port is positive proof; uncertainty must reject. */
  shutdown(operationId: string): void | Promise<void>;
  activate(operationId: string): void | Promise<void>;
  shutdownReplacement(operationId: string): void | Promise<void>;
  reactivatePrevious(operationId: string): void | Promise<void>;
}

export interface StoreTransactionResult {
  operationId: string;
  status: "committed";
  transactionDir: string;
  backupDir: string | null;
}

export interface StoreTransactionReconciliation {
  blockedIds: string[];
  /** A malformed/unattributable record requires holding all store discovery. */
  blockedAll: boolean;
  recoveredIds: string[];
}

export class StoreTransactionError extends Error {
  constructor(message: string, readonly operationId: string, readonly transactionDir: string,
    readonly blocked: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreTransactionError";
  }
}

type State = "preparing" | "prepared" | "shutting_down" | "stopped" | "publishing"
  | "published" | "activating" | "committed" | "rolling_back" | "rolled_back" | "aborted" | "blocked";
interface Journal {
  schemaVersion: 1;
  id: string;
  operationId: string;
  state: State;
  priorHash: string | null;
  stagedHash: string | null;
}
const STATES: State[] = ["preparing", "prepared", "shutting_down", "stopped", "publishing", "published",
  "activating", "committed", "rolling_back", "rolled_back", "aborted", "blocked"];
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

function validateId(id: string): void {
  if (!ID.test(id) || id.includes("..") || id.length > 160) throw new Error("Unsafe store tweak ID");
}

/** Reject symlinks in every existing path component, including the configured root. */
function safePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Store path must be absolute and normalized");
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Unsafe store symlink: ${current}`); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}
function sync(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function transactionRoot(tweaksDir: string, allowMissing = false): string {
  safePath(tweaksDir);
  if (tweaksDir === parse(tweaksDir).root || (exists(tweaksDir) ? !statSync(tweaksDir).isDirectory() : !allowMissing)) throw new Error("Unsafe tweaks directory");
  const root = join(dirname(tweaksDir), `.${basename(tweaksDir)}-store-transactions`);
  safePath(root);
  return root;
}
function ensureDirectory(path: string): void {
  safePath(path);
  if (!exists(path)) { mkdirSync(path, { mode: 0o700 }); sync(dirname(path)); }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Store transaction path is not a private owned directory: ${path}`);
  }
}

/** Hash file names, contents and permissions; reject links, special files and mount crossings. */
export function hashStoreTree(path: string, durable = false): string | null {
  safePath(path);
  if (!exists(path)) return null;
  const root = lstatSync(path);
  if (!root.isDirectory()) throw new Error(`Store tree is not a directory: ${path}`);
  const hash = createHash("sha256");
  const visit = (directory: string, relative: string) => {
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.dev !== root.dev) throw new Error("Unsafe store directory or filesystem crossing");
    hash.update(JSON.stringify(["directory", relative, before.mode & 0o777]));
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      const child = relative ? `${relative}/${name}` : name;
      if (stat.isSymbolicLink() || stat.dev !== root.dev) throw new Error("Unsafe store symlink or filesystem crossing");
      if (stat.isDirectory()) visit(file, child);
      else if (stat.isFile() && stat.nlink === 1) {
        const content = readFileSync(file);
        const after = lstatSync(file);
        if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
          throw new Error("Store tree changed while hashing");
        }
        hash.update(JSON.stringify(["file", child, stat.mode & 0o777, content.length]));
        hash.update(content);
        if (durable) sync(file);
      } else throw new Error("Unsafe store special file or hardlink");
    }
    const after = lstatSync(directory);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || JSON.stringify(names) !== JSON.stringify(readdirSync(directory).sort())) throw new Error("Store tree changed while hashing");
    if (durable) sync(directory);
  };
  visit(path, "");
  return hash.digest("hex");
}

function writeJournal(directory: string, journal: Journal): void {
  safePath(directory);
  const temporary = join(directory, `journal-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(journal) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  safePath(join(directory, "journal.json"));
  renameSync(temporary, join(directory, "journal.json"));
  sync(directory);
}

function readJournal(directory: string): Journal {
  safePath(join(directory, "journal.json"));
  const value = JSON.parse(readFileSync(join(directory, "journal.json"), "utf8")) as Journal;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "id,operationId,priorHash,schemaVersion,stagedHash,state"
    || value.schemaVersion !== 1 || typeof value.id !== "string" || !ID.test(value.id)
    || typeof value.operationId !== "string" || !UUID.test(value.operationId)
    || !STATES.includes(value.state) || ![value.priorHash, value.stagedHash].every(v => v === null || typeof v === "string" && HASH.test(v))) {
    throw new Error("Invalid store transaction journal");
  }
  validateId(value.id);
  if (basename(directory) !== `${value.id}--${value.operationId}`) throw new Error("Store journal path mismatch");
  return value;
}

function move(source: string, destination: string): void {
  safePath(source); safePath(destination);
  if (exists(destination)) throw new Error("Store rename destination already exists");
  renameSync(source, destination);
  sync(dirname(source));
  if (dirname(source) !== dirname(destination)) sync(dirname(destination));
}

/** Fresh-process only: hashes are evidence of file ownership, never of live shutdown. */
function restoreFiles(tweaksDir: string, directory: string, journal: Journal): void {
  const target = join(tweaksDir, journal.id), backup = join(directory, "backup");
  const staged = join(directory, "staging"), rejected = join(directory, "rejected");
  const currentHash = hashStoreTree(target), backupHash = hashStoreTree(backup);
  if (currentHash === journal.priorHash && backupHash === null) return;
  if (!journal.stagedHash || backupHash !== journal.priorHash) throw new Error("Store rollback hashes are ambiguous");
  if (currentHash === journal.stagedHash) {
    if (exists(staged) || exists(rejected)) throw new Error("Store replacement ownership is ambiguous");
    move(target, rejected);
  } else if (currentHash !== null || (hashStoreTree(staged) !== journal.stagedHash && hashStoreTree(rejected) !== journal.stagedHash)) {
    throw new Error("Store target changed; rollback held");
  }
  if (journal.priorHash !== null) move(backup, target);
  if (hashStoreTree(target) !== journal.priorHash) throw new Error("Restored store target does not match prior hash");
}

/** Ports must resolve only after the requested runtime state is positively known. */
export async function installStoreTransaction(options: StoreTransactionOptions): Promise<StoreTransactionResult> {
  validateId(options.id);
  const root = transactionRoot(options.tweaksDir);
  ensureDirectory(root);
  if (statSync(root).dev !== statSync(options.tweaksDir).dev) throw new Error("Store transaction must use the same filesystem");
  const locks = join(root, "locks"); ensureDirectory(locks);
  const lock = join(locks, options.id);
  // The lock survives crashes/uncertainty. Only fresh-process reconciliation releases it.
  mkdirSync(lock, { mode: 0o700 }); sync(locks);
  const operationId = randomUUID();
  const directory = join(root, `${options.id}--${operationId}`);
  const target = join(options.tweaksDir, options.id);
  let journal: Journal | undefined;
  let stopped = false, publicationIntent = false;
  let releaseLock = false;
  try {
    // Pending evidence must be reconciled at fresh startup, not during a live install.
    for (const name of readdirSync(root).filter(name => name.startsWith(`${options.id}--`))) {
      const previous = readJournal(join(root, name));
      if (!["committed", "rolled_back", "aborted"].includes(previous.state)) throw new Error("Pending store transaction requires startup reconciliation");
    }
    mkdirSync(directory, { mode: 0o700 }); sync(root);
    journal = { schemaVersion: 1, id: options.id, operationId, state: "preparing", priorHash: hashStoreTree(target, true), stagedHash: null };
    writeJournal(directory, journal);
    const staging = join(directory, "staging"); mkdirSync(staging, { mode: 0o700 }); sync(directory);
    await options.prepare(staging);
    journal.stagedHash = hashStoreTree(staging, true);
    await options.assertUnchanged(target);
    if (hashStoreTree(target) !== journal.priorHash) throw new Error("Store target changed before shutdown");
    journal.state = "prepared"; writeJournal(directory, journal);
    journal.state = "shutting_down"; writeJournal(directory, journal);
    await options.shutdown(operationId);
    stopped = true;
    journal.state = "stopped"; writeJournal(directory, journal);
    await options.assertUnchanged(target);
    if (hashStoreTree(target) !== journal.priorHash || hashStoreTree(staging) !== journal.stagedHash) {
      throw new Error("Store target or staging changed before publication");
    }
    // Journal publication intent is durable before either atomic directory rename.
    journal.state = "publishing"; writeJournal(directory, journal); publicationIntent = true;
    if (journal.priorHash !== null) {
      move(target, join(directory, "backup"));
      if (hashStoreTree(join(directory, "backup")) !== journal.priorHash) throw new Error("Store previous tree changed during publication");
    }
    move(staging, target);
    if (hashStoreTree(target) !== journal.stagedHash) throw new Error("Store replacement tree changed during publication");
    journal.state = "published"; writeJournal(directory, journal);
    journal.state = "activating"; writeJournal(directory, journal);
    await options.activate(operationId);
    journal.state = "committed"; writeJournal(directory, journal);
    releaseLock = true;
    return { operationId, status: "committed", transactionDir: directory,
      backupDir: journal.priorHash === null ? null : join(directory, "backup") };
  } catch (cause) {
    let blocked = true;
    if (journal) {
      try {
        if (["preparing", "prepared"].includes(journal.state)) {
          journal.state = "aborted"; writeJournal(directory, journal); blocked = false;
        } else if (stopped) {
          if (publicationIntent) {
            // Even activation failure may have left a replacement runtime running.
            await options.shutdownReplacement(operationId);
            journal.state = "rolling_back"; writeJournal(directory, journal);
            restoreFiles(options.tweaksDir, directory, journal);
          } else if (hashStoreTree(target) !== journal.priorHash) throw new Error("Previous store tree changed; reactivation held");
          await options.reactivatePrevious(operationId);
          journal.state = "rolled_back"; writeJournal(directory, journal); blocked = false;
        }
      } catch { /* Preserve all evidence and keep discovery/admission blocked. */ }
      if (blocked) { journal.state = "blocked"; try { writeJournal(directory, journal); } catch { /* Prior durable intent remains. */ } }
    }
    releaseLock = !blocked;
    throw new StoreTransactionError(`Store installation failed${blocked ? "; reconciliation required" : "; previous files retained"}: ${cause instanceof Error ? cause.message : String(cause)}`,
      operationId, directory, blocked, { cause });
  } finally {
    if (releaseLock) { rmdirSync(lock); sync(locks); }
  }
}

/** Invoke once in a fresh process, before discovery or any tweak runtime starts. */
export function reconcileStoreTransactions(tweaksDir: string): StoreTransactionReconciliation {
  const result: StoreTransactionReconciliation = { blockedIds: [], blockedAll: false, recoveredIds: [] };
  const blocked = new Set<string>(), recovered = new Set<string>();
  let root: string;
  try {
    root = transactionRoot(tweaksDir, true);
    if (!exists(root)) return result;
    if (!exists(tweaksDir)) throw new Error("Store evidence exists but tweaks directory is missing");
  }
  catch { return { ...result, blockedAll: true }; }
  const seen = new Set<string>();
  try {
    ensureDirectory(root);
    if (statSync(root).dev !== statSync(tweaksDir).dev) throw new Error("Unsafe transaction root");
    for (const name of readdirSync(root).sort()) {
      if (name === "locks") continue;
      const match = /^(.*)--([0-9a-f-]+)$/.exec(name);
      const id = match?.[1];
      try {
        if (!id) throw new Error("Unknown store transaction path");
        validateId(id);
        const directory = join(root, name), journal = readJournal(directory);
        seen.add(id);
        if (["committed", "rolled_back", "aborted"].includes(journal.state)) continue;
        // Persist recovery intent before touching any files; repeatable after a crash.
        const originalState = journal.state;
        journal.state = "rolling_back"; writeJournal(directory, journal);
        restoreFiles(tweaksDir, directory, journal);
        journal.state = originalState === "preparing" || originalState === "prepared" ? "aborted" : "rolled_back";
        writeJournal(directory, journal); recovered.add(id);
      } catch {
        if (id && ID.test(id) && !id.includes("..")) blocked.add(id);
        else result.blockedAll = true;
      }
    }
    const locks = join(root, "locks");
    if (exists(locks)) {
      safePath(locks);
      for (const id of readdirSync(locks)) {
        try {
          validateId(id);
          const lock = join(locks, id); safePath(lock);
          if (!seen.has(id) || blocked.has(id) || result.blockedAll) { blocked.add(id); continue; }
          // Only empty lock directories created by this protocol can be released.
          rmdirSync(lock); sync(locks);
        } catch { if (ID.test(id) && !id.includes("..")) blocked.add(id); else result.blockedAll = true; }
      }
    }
  } catch { result.blockedAll = true; }
  result.blockedIds = [...blocked].sort();
  result.recoveredIds = [...recovered].filter(id => !blocked.has(id)).sort();
  return result;
}

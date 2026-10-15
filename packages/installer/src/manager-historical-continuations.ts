import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import plist from "plist";
import { createWatcherConfiguration } from "./watcher.js";
import { readManagedRuntimeFingerprintEvidence } from "./managed-runtime.js";
import { parsePreparedOperation } from "./manager-operation-store.js";
import { parseManagerStrictJsonObject } from "./manager-strict-json.js";
import { inspectHistoricalManagerReconciliation, type HistoricalManagerObservedOperation } from "./manager-historical-reconciliation.js";
import { authenticateSettledAcceptedRuntimeRepairPromotion, authenticateSupersededAcceptedRuntimeRepairPromotion } from "./accepted-runtime-repair.js";

/** Production supplies the full current-generation/settled-child authenticator,
 * never a caller approval flag. The callback permits focused decision tests. */
export function assertHistoricalPromotionAdmissionRecord(value:Record<string,unknown>,name:string,allowedPromotionId:string|undefined,
  authenticateSettledChild:(promotionId:string,operationId:string)=>boolean):void {
  if(name!==`${value.id}.json`)throw new Error("Current promotion recovery work blocks historical admission");
  if(["committed","recovered"].includes(String(value.phase))||value.id===allowedPromotionId&&value.phase==="prepared")return;
  const binding=value.acceptedBackendTransition;
  if(value.phase==="app:promoted"&&typeof value.id==="string"&&binding&&typeof binding==="object"&&!Array.isArray(binding)
    &&typeof (binding as Record<string,unknown>).operationId==="string"
    &&authenticateSettledChild(value.id,(binding as {operationId:string}).operationId))return;
  throw new Error("Current promotion recovery work blocks historical admission");
}

export interface HistoricalContinuationObservation { kind: "process" | "job"; identity: string; command: string }
export function historicalContinuationMatches(root: string, operations: readonly HistoricalManagerObservedOperation[], observation: HistoricalContinuationObservation): boolean {
  const own = operations.flatMap(({ record }) => [record.operationId, dirname(record.moduleIdentity.path)]);
  const generic = [join(root, "transactions"), join(root, "managers"), join(root, "runtime", "dist"), join(root, "managed-runtime"),
    join(dirname(root), "codex-plusplus"), join(dirname(root), "Codex++")];
  const forms = commandForms(observation.command);
  return [...own, ...generic, ...(observation.kind === "job" ? [root] : [])]
    .some(needle => forms.some(form => form.includes(needle)));

}
function commandForms(text: string): string[] {
  const forms = [text];
  // Decode data, never execute shell input. Removing quoting/escaping can only
  // add conservative matches; it cannot excuse a referenced old operation.
  try {
    const visit = (value: unknown): void => {
      if (typeof value === "string") forms.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(JSON.parse(text));
  } catch { /* ps and launchctl documents are not JSON. */ }
  return forms.flatMap(value => [value, value.replace(/\\(.)/gs, "$1").replace(/['"]/g, "")]);
}
/** System Events does not consume our inert test-fixture variable. Keep every
 * executable argument and every other environment reference in the census. */
export function historicalLoadedJobCommand(root: string, operations: readonly HistoricalManagerObservedOperation[], name: string, detail: string): string {
  const executable = "/System/Library/CoreServices/System Events.app/Contents/MacOS/System Events";
  if (!/^gui\/\d+\/application\.com\.apple\.systemevents\.\d+\.\d+$/.test(name)
    || !detail.includes(`\n\tprogram = ${executable}\n`)
    || !detail.includes(`\n\targuments = {\n\t\t${executable}\n\t}\n`)
    || referencesOwnOperation(operations, detail)) return detail;
  return detail.split("\n").filter(line => {
    const prefix = `\t\tTWEAKERS_TEST_20156_ASAR => ${root}/official-source/baselines/`;
    return !(line.startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resources\/app\.asar$/.test(line.slice(prefix.length)));
  }).join("\n");
}
function referencesOwnOperation(operations: readonly HistoricalManagerObservedOperation[], text: string): boolean {
  return operations.some(({ record }) => commandForms(text).some(form => form.includes(record.operationId) || form.includes(dirname(record.moduleIdentity.path))));
}
function verifiedWatcherDefinition(root: string, path: string, value: Record<string, unknown>): boolean {
  if (value.Label !== "com.therealityreport.tweakers.watcher" || !Array.isArray(value.WatchPaths) || value.WatchPaths.length !== 1) return false;
  const watched = value.WatchPaths[0];
  if (typeof watched !== "string" || !watched.endsWith("/Contents/Resources/app.asar")) return false;
  const expected = createWatcherConfiguration(watched.slice(0, -"/Contents/Resources/app.asar".length));
  if (expected.targetPath !== path || !expected.bytes) return false;
  const wanted = plist.parse(expected.bytes.toString("utf8")) as Record<string, unknown>;
  const canonical = (item: unknown): string => JSON.stringify(item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return canonical(value) === canonical(wanted) && readManagedRuntimeFingerprintEvidence(join(root, "managed-runtime", "current")) !== null;
}
export function loadedHistoricalWatcherMatches(root: string, operations: readonly HistoricalManagerObservedOperation[], detail: string, path: string, expected: Record<string, unknown>): boolean {
  const args = /\n\targuments = \{\n([\s\S]*?)\n\t\}/.exec(detail);
  if (!args || !detail.includes(`\n\tpath = ${path}\n`) || !detail.includes("\n\tprogram = /bin/sh\n")) return false;
  const values = args[1]!.split("\n").map(line => line.startsWith("\t\t") ? line.slice(2) : null);
  const remainder = detail.replace(args[0], "").replace(`\n\tpath = ${path}\n`, "\n").replace("\n\tprogram = /bin/sh\n", "\n");
  return JSON.stringify(values) === JSON.stringify(expected.ProgramArguments)
    && !/\n\t(?:working directory|arguments|path|program) = /.test(remainder)
    && !historicalContinuationMatches(root, operations, { kind: "job", identity: path, command: remainder });
}

function command(file: string, args: string[]): { text: string; pid: number } {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
  if (result.error || result.status !== 0) throw new Error(`Historical cessation observation failed: ${file}`);
  return { text: result.stdout, pid: result.pid };
}
export function parseHistoricalLaunchServices(text: string, domain: string): string[] {
  if (!text.startsWith(`${domain} = {\n`) || !text.trimEnd().endsWith("\n}")) throw new Error("Unexpected launch service domain");
  const block = /\n\tservices = \{\n([\s\S]*?)\t\}/.exec(text);
  if (!block) throw new Error("Launch service census is missing");
  return block[1]!.split("\n").filter(line => line.trim()).map(line => {
    const match = /^\t\t\s*\d+\s+(?:-?\d+|-|\([a-z]{1,3}\))\s+([^\s]+)\s*$/.exec(line);
    if (!match) throw new Error("Launch service census is malformed");
    return match[1]!;
  });
}
export interface HistoricalDaemonBoundary {
  directory: string; regular: boolean; canonical: boolean; uid: number; mode: number;
  parentRootOwned: boolean; readable: boolean; writable: boolean; parentWritable: boolean;
}
/** Supported Manager publishers run as the user and cannot install system daemons.
 * This excludes a publication scope, never certifies unreadable file contents.
 * Issuers must retain their source-scope analysis and historical provenance limits.
 */
export function historicalDaemonOutsidePublicationScope(value: HistoricalDaemonBoundary): boolean {
  return value.directory === "/Library/LaunchDaemons" && value.regular && value.canonical && value.uid === 0
    && (value.mode & 0o022) === 0 && value.parentRootOwned && !value.readable && !value.writable && !value.parentWritable;
}
function canAccess(path: string, mode: number): boolean {
  try { accessSync(path, mode); return true; }
  catch (error) { if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
}
/** Read-only supported-continuation census. Raw commands/environment are never retained. */
export function observeHistoricalManagerCessation(root: string, operations: readonly HistoricalManagerObservedOperation[]) {
  if (process.platform !== "darwin" || !process.getuid) throw new Error("Historical cessation requires macOS process and launchd evidence");
  const uid = process.getuid();
  const conflicts: { kind: string; identity: string }[] = [];
  const ps = command("/bin/ps", ["-ww", "-axo", "pid=,ppid=,lstart=,args="]);
  const rows = ps.text.split("\n").filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/.exec(line);
    if (!match) throw new Error("Historical process census is malformed");
    return { pid: Number(match[1]), parent: Number(match[2]), startedAt: match[3]!, command: match[4]! };
  });
  const excluded = new Set<number>();
  let parent: number = process.pid;
  while (parent > 0 && !excluded.has(parent)) { excluded.add(parent); const row = rows.find(row => row.pid === parent); if (!row) throw new Error("Observer ancestry is incomplete"); parent = row.parent; }
  for (const row of rows) {
    if (excluded.has(row.pid) || row.pid === ps.pid && row.command === "/bin/ps -ww -axo pid=,ppid=,lstart=,args=") continue;
    if (historicalContinuationMatches(root, operations, { kind: "process", identity: String(row.pid), command: row.command })) conflicts.push({ kind: "process", identity: String(row.pid) });
  }
  const domains = [`gui/${uid}`, `user/${uid}`, "system"];
  const loadedMatches: { name: string; detail: string }[] = [];
  const loaded: { domain: string; count: number; digest: string }[] = [];
  for (const domain of domains) {
    const text = command("/bin/launchctl", ["print", domain]).text;
    const services = parseHistoricalLaunchServices(text, domain);
    for (const service of services) {
      const name = `${domain}/${service}`;
      const detail = command("/bin/launchctl", ["print", name]).text;
      if (!detail.startsWith(`${name} = {\n`) || !detail.trimEnd().endsWith("}")) throw new Error("Loaded job identity is unreadable");
      // Match the entire in-memory document, including arguments, working directory,
      // environment and paths. Only a hash/count is retained, never its contents.
      if (historicalContinuationMatches(root, operations, { kind: "job", identity: name, command: historicalLoadedJobCommand(root, operations, name, detail) })) loadedMatches.push({ name, detail });
    }
    loaded.push({ domain, count: services.length, digest: createHash("sha256").update(text).digest("hex") });
  }
  const excludedPrivilegedDefinitions: { path: string; uid: number; mode: number; device: number; inode: number; modifiedAt: string; changeTime: string; state: string }[] = [];
  const supportedWatchers = new Map<string, Record<string, unknown>>();
  const persisted: { directory: string; count: number }[] = [];
  for (const directory of [join(homedir(), "Library", "LaunchAgents"), "/Library/LaunchAgents", "/Library/LaunchDaemons"]) {
    try { if (!lstatSync(directory).isDirectory()) throw new Error("Persisted job directory is unsafe"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { persisted.push({ directory, count: 0 }); continue; } throw error; }
    const names = readdirSync(directory).filter(name => name.endsWith(".plist"));
    for (const name of names) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Persisted job is not a regular file");
      let text: string;
      try { text = command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path]).text; }
      catch {
        const parent = lstatSync(directory);
        const outside = historicalDaemonOutsidePublicationScope({ directory, regular: stat.isFile() && !stat.isSymbolicLink(),
          canonical: realpathSync(path) === path && realpathSync(directory) === directory,
          uid: stat.uid, mode: stat.mode, parentRootOwned: parent.uid === 0 && !parent.isSymbolicLink() && (parent.mode & 0o022) === 0,
          readable: canAccess(path, constants.R_OK), writable: canAccess(path, constants.W_OK), parentWritable: canAccess(directory, constants.W_OK) });
        if (!outside || historicalContinuationMatches(root, operations, { kind: "job", identity: path, command: path })
          || /tweakers|codex[-+]plusplus|codex\+\+/i.test(path)) throw new Error(`Persisted job is unreadable: ${path}`);
        excludedPrivilegedDefinitions.push({ path, uid: stat.uid, mode: stat.mode & 0o7777, device: stat.dev, inode: stat.ino,
          modifiedAt: stat.mtime.toISOString(), changeTime: stat.ctime.toISOString(), state: "unreadable-outside-supported-manager-publication-scope" });
        continue;
      }
      const value = JSON.parse(text) as Record<string, unknown>;
      const normalized = JSON.stringify(value);
      if (historicalContinuationMatches(root, operations, { kind: "job", identity: path, command: normalized })) {
        if (!referencesOwnOperation(operations, normalized) && verifiedWatcherDefinition(root, path, value)) supportedWatchers.set(path, value);
        else conflicts.push({ kind: "persisted-job", identity: path });
      }
    }
    persisted.push({ directory, count: names.length });
  }
  for (const { name, detail } of loadedMatches) {
    if (referencesOwnOperation(operations, detail) || ![...supportedWatchers].some(([path, value]) =>
      name === `gui/${uid}/${value.Label}` && loadedHistoricalWatcherMatches(root, operations, detail, path, value))) {
      conflicts.push({ kind: "loaded-job", identity: name });
    }
  }
  if (conflicts.length) throw new Error(`Historical Manager continuations remain: ${JSON.stringify(conflicts)}`);
  return { observedAt: new Date().toISOString(), publicationScope: "repository-supported-user-manager-continuations-v1", excludedPrivilegedDefinitions, processCount: rows.length, processCensusSha256: createHash("sha256").update(ps.text).digest("hex"), loaded, persisted, conflicts };
}

/** Called only at mutation admission; ordinary status remains filesystem-only. */
export function assertHistoricalManagerAdmission(root: string, allowedPromotionId?: string): void {
  try { lstatSync(join(root, "transactions", "manager-historical-reconciliation")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const directory = join(root, "transactions", "manager-operations");
  const operations = readdirSync(directory).filter(name => name.endsWith(".json")).map(name => {
    const rawText = readFileSync(join(directory, name), "utf8");
    return { rawText, record: parsePreparedOperation(parseManagerStrictJsonObject(rawText, { maxBytes: 64 * 1024, label: "Manager admission record" }), name.slice(0, -5)) };
  });
  const inspection = inspectHistoricalManagerReconciliation(root, operations);
  if (inspection.problems.length) throw new Error(inspection.problems.join("; "));
  if (inspection.classifiedOperationIds.length) {
    const journals = join(root, "variants", "tweakers", "transactions", "variant-promotion");
    for (const name of readdirSync(journals).filter(name => name.endsWith(".json") && name !== "active.json")) {
      const value = parseManagerStrictJsonObject(readFileSync(join(journals, name), "utf8"), { maxBytes: 1024 * 1024, label: "Current promotion journal" });
      assertHistoricalPromotionAdmissionRecord(value,name,allowedPromotionId,(promotionId,operationId)=>
        authenticateSupersededAcceptedRuntimeRepairPromotion(join(root,"variants","tweakers"),promotionId,operationId)
        ||authenticateSettledAcceptedRuntimeRepairPromotion(join(root,"variants","tweakers"),promotionId,operationId));
    }
  }
  if (inspection.classifiedOperationIds.length) observeHistoricalManagerCessation(root, operations.filter(item => inspection.classifiedOperationIds.includes(item.record.operationId)));
}

import { verifyRuntimeReadyReceiptBinding, type IndependentTweakersRuntimeReadyExpectation } from "./runtime-ready-receipt.js";
import { readAcceptedRuntimeRepairRecord, readAuthenticatedAcceptedRuntimeRepair, settleAcceptedRuntimeRepair } from "./accepted-runtime-repair.js";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalManagerJson, MANAGER_REFRESH_TIMING_PHASES_V1, type TweakersManagerPreparedOperationV1 } from "./manager-contract.js";
import { isCandidateCopyPrecutoverFailure, isRunningTargetPrecutoverFailure, isManagerOperationId, ManagerOperationStore } from "./manager-operation-store.js";
import { assertManagerExactObjectKeys, isManagerJsonObject, parseManagerStrictJsonObject } from "./manager-strict-json.js";
import { fingerprintVariantGeneration, type VariantGenerationFingerprint } from "./variant-generation.js";
import { assertAcceptedSharedNativeBackendTransitionShape } from "./shared-native-backend-transition.js";
import { TWEAKERS_ACCOUNTS_TWEAK_ID } from "./macos-variant.js";

const HEX = /^[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ENTRY_NAMES = ["runtime", "tweaks", "state.json", "config.json", "app"] as const;
export interface ManagerRecoveryBindingV1 {
  schemaVersion: 1;
  kind: "tweakers-manager-recovery-binding";
  operationId: string;
  promotionId: string;
  userRoot: string;
  target: string;
  generation: { appSha256: string; runtimeFingerprint: string; activeReceiptSha256: string };
  journal: { path: string; identitySha256: string };
  receiptRefs: string[];
  dependencyPaths: string[];
  createdAt: string;
}
interface JournalEntry {
  name?: string; source: string; destination: string; archive: string; failed: string;
  hadDestination: boolean; desired: VariantGenerationFingerprint; previous: VariantGenerationFingerprint | null;
}
export type RecoveryTextRead = { state: "missing" } | { state: "present"; text: string } | { state: "unreadable"; problem: string };
export interface RecoveryEvidenceDependencies {
  readText?: (path: string) => RecoveryTextRead;
  fingerprint?: (path: string) => VariantGenerationFingerprint;
  absent?: (path: string) => boolean;
  /** When observing a durable operation, compare its original receipt binding. */
  expectedReceiptRefs?: readonly string[];
  consumedAt?: string;
}

/** Exact operation-local evidence that no publication boundary was reached. */
export function managerOperationHasSafePrepublicationFailure(record: TweakersManagerPreparedOperationV1): boolean {
  if (record.phase !== "recovery-required" || record.actionId !== "refresh.independent" || record.consumedAt === null
    || record.receiptRefs.length !== 1 || !record.receiptRefs[0]?.startsWith("independent-tweakers-patch:") || record.error === null) return false;
  if (isCandidateCopyPrecutoverFailure(record) || isRunningTargetPrecutoverFailure(record)) return true;
  return record.error.startsWith("Independent Tweakers refresh requires a source-bound validated Accounts recovery receipt in the sealed runtime.")
    && !!record.timing && MANAGER_REFRESH_TIMING_PHASES_V1.every(key => {
      const phase = record.timing!.phases[key];
      return phase.state === "skipped" && phase.startedAt === null && phase.completedAt === null;
    });
}

export function managerRecoveryBindingPath(managerRoot: string, operationId: string): string {
  assertRoot(managerRoot); assertId(operationId);
  return join(managerRoot, "transactions", "manager-recovery-bindings", `${operationId}.json`);
}

/** The journal phase changes; every other field is an immutable generation identity. */
export function managerRecoveryJournalIdentitySha256(journal: unknown): string {
  if (!isManagerJsonObject(journal)) throw new Error("Recovery journal must be an object");
  const { phase: _phase, ...identity } = journal;
  return createHash("sha256").update(canonicalManagerJson(identity)).digest("hex");
}

export function createManagerRecoveryBinding(input: {
  managerRoot: string; operationId: string; journal: unknown; runtimeFingerprint: string;
  receiptRefs: readonly string[]; dependencyPaths: readonly string[]; createdAt?: string;
}): ManagerRecoveryBindingV1 {
  const journal = validateJournal(input.managerRoot, input.journal, input.operationId);
  const app = journal.entries.find(entry => entry.name === "app")!;
  const binding: ManagerRecoveryBindingV1 = {
    schemaVersion: 1, kind: "tweakers-manager-recovery-binding", operationId: input.operationId,
    promotionId: journal.id, userRoot: journal.userRoot, target: journal.target,
    generation: { appSha256: app.desired.sha256, runtimeFingerprint: input.runtimeFingerprint, activeReceiptSha256: journal.activeReceipt.desired.sha256 },
    journal: { path: join(journal.userRoot, "transactions", "variant-promotion", `${journal.id}.json`), identitySha256: managerRecoveryJournalIdentitySha256(input.journal) },
    receiptRefs: [...input.receiptRefs], dependencyPaths: [...new Set([...input.dependencyPaths,
      dirname(managerRecoveryBindingPath(input.managerRoot, input.operationId))])], createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return parseManagerRecoveryBinding(input.managerRoot, binding, input.operationId);
}

export function parseManagerRecoveryBinding(managerRoot: string, value: unknown, operationId: string): ManagerRecoveryBindingV1 {
  assertRoot(managerRoot); assertId(operationId);
  if (!isManagerJsonObject(value)) throw new Error("Recovery binding is not an object");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) throw new Error("Recovery binding exceeds its write limit");
  assertManagerExactObjectKeys(value, ["schemaVersion", "kind", "operationId", "promotionId", "userRoot", "target", "generation", "journal", "receiptRefs", "dependencyPaths", "createdAt"], "Recovery binding");
  const userRoot = join(managerRoot, "variants", "tweakers");
  if (value.schemaVersion !== 1 || value.kind !== "tweakers-manager-recovery-binding" || value.operationId !== operationId
    || !isManagerOperationId(String(value.promotionId)) || value.userRoot !== userRoot || value.target !== "/Applications/Tweakers.app"
    || typeof value.createdAt !== "string" || !RFC3339.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Recovery binding identity is invalid");
  if (!isManagerJsonObject(value.generation) || !isManagerJsonObject(value.journal)) throw new Error("Recovery binding generation is invalid");
  assertManagerExactObjectKeys(value.generation, ["appSha256", "runtimeFingerprint", "activeReceiptSha256"], "Recovery generation");
  assertManagerExactObjectKeys(value.journal, ["path", "identitySha256"], "Recovery journal binding");
  if (!Object.values(value.generation).every(field => typeof field === "string" && HEX.test(field))
    || typeof value.journal.identitySha256 !== "string" || !HEX.test(value.journal.identitySha256)
    || value.journal.path !== join(userRoot, "transactions", "variant-promotion", `${value.promotionId}.json`)) throw new Error("Recovery binding fingerprint or journal path is invalid");
  if (!Array.isArray(value.receiptRefs) || value.receiptRefs.length > 32 || !value.receiptRefs.every(ref => typeof ref === "string" && ref.length > 0 && ref.length <= 2048 && !/[\u0000-\u001f]/.test(ref))
    || !Array.isArray(value.dependencyPaths) || value.dependencyPaths.length > 64
    || !value.dependencyPaths.every(path => typeof path === "string" && path === resolve(path) && path.startsWith(managerRoot + "/") && !/[\u0000-\u001f]/.test(path))) throw new Error("Recovery binding references are invalid");
  return value as unknown as ManagerRecoveryBindingV1;
}

/** Called by the existing promotion owner before publication. Immutable and durable. */
export function persistManagerRecoveryBinding(managerRoot: string, binding: ManagerRecoveryBindingV1): void {
  const checked = parseManagerRecoveryBinding(managerRoot, binding, binding.operationId);
  const file = managerRecoveryBindingPath(managerRoot, binding.operationId), directory = dirname(file);
  if (realpathSync(managerRoot) !== managerRoot) throw new Error("Recovery root must not traverse symlinks");
  for (const path of [join(managerRoot, "transactions"), directory]) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    // The shared transaction parent predates private recovery evidence. It may
    // be readable, but only its owner may write; the evidence leaf stays private.
    assertPrivate(path, true, path !== directory);
    const parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  }
  const existing = readManagerRecoveryBinding(managerRoot, binding.operationId);
  if (existing !== null) {
    if (canonicalManagerJson(existing) !== canonicalManagerJson(checked)) throw new Error("Operation recovery binding is immutable");
    return;
  }
  const staging = join(directory, `.binding-${randomUUID()}`);
  const fd = openSync(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(checked) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    linkSync(staging, file); // Atomic publication without replacement of an existing binding.
    const parent = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { unlinkSync(staging); }
}

export function readManagerRecoveryBinding(managerRoot: string, operationId: string, readText = readPrivateRecoveryText): ManagerRecoveryBindingV1 | null {
  const read = readText(managerRecoveryBindingPath(managerRoot, operationId));
  if (read.state === "missing") return null;
  if (read.state !== "present") throw new Error("Operation recovery binding is unreadable");
  return parseManagerRecoveryBinding(managerRoot, parseManagerStrictJsonObject(read.text), operationId);
}

/** Store only after the live coordinator has checked the process and current broker authority. */
export function persistManagerRuntimeAcceptance(managerRoot: string, expectation: IndependentTweakersRuntimeReadyExpectation,
  receipt: unknown, pid: number, processStartToken: string): void {
  verifyRuntimeReadyReceiptBinding(expectation, receipt, pid, processStartToken);
  if (!isManagerOperationId(expectation.operationId)) return; // Legacy direct operations have no Manager record.
  const binding = readManagerRecoveryBinding(managerRoot, expectation.operationId);
  if (!binding) return; // Direct CLI operations do not own a Manager record.
  if(expectation.schemaVersion===6) {
    const child=readAuthenticatedAcceptedRuntimeRepair(expectation.operationId),childHead=readAcceptedRuntimeRepairRecord(expectation.operationId);
    if(!child||child.phase!=="challenge:published"||!childHead
      ||canonicalManagerJson(child.runtimeRepair)!==canonicalManagerJson(expectation.runtimeRepair)
      ||expectation.promotionId!==binding.promotionId||expectation.appRoot!==binding.target
      ||expectation.runtimeFingerprint!==childHead.intent.authority.repairedRuntime.evidence.fingerprint
      ||expectation.activePromotionReceiptSha256!==fingerprintVariantGeneration(childHead.intent.effectiveActiveReceipt.path).sha256)
      throw new Error("Runtime acceptance does not match its authenticated repair child");
  }else if (expectation.promotionId !== binding.promotionId || expectation.appRoot !== binding.target
    || expectation.runtimeFingerprint !== binding.generation.runtimeFingerprint
    || expectation.activePromotionReceiptSha256 !== binding.generation.activeReceiptSha256) throw new Error("Runtime acceptance does not match its operation binding");
  const value = { schemaVersion: 1, kind: "tweakers-manager-runtime-acceptance", expectation, receipt, pid, processStartToken };
  const directory = dirname(managerRecoveryBindingPath(managerRoot, expectation.operationId));
  assertPrivate(directory, true);
  let file = expectation.schemaVersion===6 ? managerRuntimeAcceptanceAttemptPath(managerRoot,expectation.operationId,receipt)
    : managerRuntimeAcceptancePath(managerRoot, expectation.operationId);
  let existing = readPrivateRecoveryText(file);
  if (existing.state === "present") {
    if (canonicalManagerJson(parseManagerStrictJsonObject(existing.text)) === canonicalManagerJson(value)) return;
    // Keep the first accepted process proof. A recovered launch records a new
    // immutable attempt, selected by the exact current readiness receipt.
    file = managerRuntimeAcceptanceAttemptPath(managerRoot, expectation.operationId, receipt);
    existing = readPrivateRecoveryText(file);
    if (existing.state === "present") {
      if (canonicalManagerJson(parseManagerStrictJsonObject(existing.text)) !== canonicalManagerJson(value)) throw new Error("Runtime acceptance attempt is immutable");
      return;
    }
  }
  if (existing.state !== "missing") throw new Error("Runtime acceptance is unreadable");
  const staging = join(directory, `.acceptance-${randomUUID()}`);
  const fd = openSync(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    linkSync(staging, file);
    const parent = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { unlinkSync(staging); }
}
/** Retained live promotions cannot use the direct-CLI missing-binding exception. */
export function persistRequiredManagerRuntimeAcceptance(managerRoot: string, expectation: IndependentTweakersRuntimeReadyExpectation,
  receipt: unknown, pid: number, processStartToken: string): void {
  const binding = readManagerRecoveryBinding(managerRoot, expectation.operationId);
  if (!binding) throw new Error("Retained promotion requires its immutable recovery binding");
  persistManagerRuntimeAcceptance(managerRoot, expectation, receipt, pid, processStartToken);
  if (canonicalManagerJson(readManagerRecoveryBinding(managerRoot, expectation.operationId)) !== canonicalManagerJson(binding))
    throw new Error("Retained recovery binding changed during acceptance persistence");
  const expected = canonicalManagerJson({schemaVersion: 1, kind: "tweakers-manager-runtime-acceptance", expectation, receipt, pid, processStartToken});
  const paths = [managerRuntimeAcceptancePath(managerRoot, expectation.operationId), managerRuntimeAcceptanceAttemptPath(managerRoot, expectation.operationId, receipt)];
  if (!paths.some(path => {
    const value = readPrivateRecoveryText(path);
    if (value.state === "unreadable") throw new Error("Retained runtime acceptance is unreadable");
    return value.state === "present" && canonicalManagerJson(parseManagerStrictJsonObject(value.text)) === expected;
  })) throw new Error("Retained runtime acceptance was not durably persisted");
}

export function managerRuntimeAcceptancePath(managerRoot: string, operationId: string): string {
  return managerRecoveryBindingPath(managerRoot, operationId).replace(/\.json$/, ".acceptance.json");
}
export function managerRuntimeAcceptanceAttemptPath(managerRoot: string, operationId: string, receipt: unknown): string {
  const digest = createHash("sha256").update(canonicalManagerJson(receipt)).digest("hex");
  return managerRuntimeAcceptancePath(managerRoot, operationId).replace(/\.json$/, `.${digest}.json`);
}

/** Resolve recovery only from the consumed operation and its immutable binding. */
export function readManagerRetainedPromotionEvidence(managerRoot: string, operationId: string): {
  binding: ManagerRecoveryBindingV1; journalSha256: string; committed: boolean; acceptedBackendTransition: boolean;
} {
  const record = new ManagerOperationStore(managerRoot).read(operationId);
  if (!record || record.actionId !== "refresh.independent" || !["consumed", "recovery-required", "completed"].includes(record.phase)
    || record.consumedAt === null) throw new Error("Accepted backend recovery requires its original consumed independent refresh operation");
  const binding = readManagerRecoveryBinding(managerRoot, operationId);
  if (!binding || canonicalManagerJson(binding.receiptRefs) !== canonicalManagerJson(record.receiptRefs)
    || Date.parse(binding.createdAt) < Date.parse(record.consumedAt)) throw new Error("Accepted backend recovery operation binding changed");
  const read = readPrivateRecoveryText(binding.journal.path);
  if (read.state !== "present") throw new Error("Accepted backend recovery journal is unavailable");
  const value = parseManagerStrictJsonObject(read.text);
  const journal = validateJournal(managerRoot, value, operationId);
  if (journal.id !== binding.promotionId
    || managerRecoveryJournalIdentitySha256(value) !== binding.journal.identitySha256
    || journal.entries.find(entry => entry.name === "app")!.desired.sha256 !== binding.generation.appSha256
    || journal.activeReceipt.desired.sha256 !== binding.generation.activeReceiptSha256) throw new Error("Accepted backend recovery journal authority changed");
  return { binding, journalSha256: createHash("sha256").update(read.text).digest("hex"), committed: journal.phase === "committed", acceptedBackendTransition: !!value.acceptedBackendTransition };
}

export function readManagerAcceptedBackendRecoveryEvidence(managerRoot: string, operationId: string): {
  binding: ManagerRecoveryBindingV1; journalSha256: string; committed: boolean;
} {
  const evidence = readManagerRetainedPromotionEvidence(managerRoot, operationId);
  if (!evidence.acceptedBackendTransition) throw new Error("Accepted backend recovery journal authority changed");
  const {acceptedBackendTransition: _transition, ...result} = evidence;
  return result;
}

export function settleManagerAcceptedBackendRecovery(managerRoot: string, operationId: string, dependencies: RecoveryEvidenceDependencies = {}): boolean {
  const childHead=join(managerRoot,"transactions","manager-recovery-bindings",`${operationId}.runtime-repair-head.json`);
  if(existsSync(childHead)) {
    // The original promotion/CAS body stays immutable. A single authenticated
    // child supplies its effective committed generation and durable canary.
    return settleAcceptedRuntimeRepair(operationId);
  }
  const evidence = readManagerAcceptedBackendRecoveryEvidence(managerRoot, operationId);
  const store = new ManagerOperationStore(managerRoot), record = store.read(operationId)!;
  if (!evidence.committed || !managerOperationRecoveryIsVerified(managerRoot, operationId, { ...dependencies,
    expectedReceiptRefs: record.receiptRefs, consumedAt: record.consumedAt! })) return false;
  settleVerifiedManagerRecoveryOperations(managerRoot, store, new Date().toISOString(), dependencies);
  return store.read(operationId)?.phase === "completed";
}

/** Phase labels alone never establish acceptance or restoration. */
export function managerOperationRecoveryIsVerified(managerRoot: string, operationId: string, dependencies: RecoveryEvidenceDependencies = {}): boolean {
  if(existsSync(join(managerRoot,"transactions","manager-recovery-bindings",`${operationId}.runtime-repair-head.json`))) {
    try{return readAuthenticatedAcceptedRuntimeRepair(operationId)?.phase==="committed";}catch{return false;}
  }
  const readText = dependencies.readText ?? readPrivateRecoveryText;
  const fingerprint = dependencies.fingerprint ?? ((path: string) => {
    if (realpathSync(path) !== path) throw new Error("Recovery destination traverses a symlink");
    return fingerprintVariantGeneration(path);
  });
  const absent = dependencies.absent ?? definitelyAbsent;
  try {
    const binding = readManagerRecoveryBinding(managerRoot, operationId, readText);
    if (!binding) return false;
    if (dependencies.expectedReceiptRefs && canonicalManagerJson(binding.receiptRefs) !== canonicalManagerJson(dependencies.expectedReceiptRefs)) return false;
    if (dependencies.consumedAt && Date.parse(binding.createdAt) < Date.parse(dependencies.consumedAt)) return false;
    const read = readText(binding.journal.path);
    if (read.state !== "present") return false;
    const value = parseManagerStrictJsonObject(read.text);
    const journal = validateJournal(managerRoot, value, operationId);
    if (journal.id !== binding.promotionId || managerRecoveryJournalIdentitySha256(value) !== binding.journal.identitySha256
      || journal.entries.find(entry => entry.name === "app")!.desired.sha256 !== binding.generation.appSha256
      || journal.activeReceipt.desired.sha256 !== binding.generation.activeReceiptSha256) return false;
    const matches = (path: string, wanted: VariantGenerationFingerprint) => canonicalManagerJson(fingerprint(path)) === canonicalManagerJson(wanted);
    const entries = [...journal.entries.filter(entry => entry.name !== "config.json"), journal.activeReceipt];
    if (journal.phase === "recovered") {
      for (const name of ["runtime-ready-expectation.json", "runtime-ready.json"]) {
        const ready = readText(join(binding.userRoot, name));
        if (ready.state === "unreadable") return false;
        if (ready.state === "present" && parseManagerStrictJsonObject(ready.text).operationId === operationId) return false;
      }
      return entries.every(entry => entry.previous ? matches(entry.destination, entry.previous) : absent(entry.destination));
    }
    if (journal.phase !== "committed" || !entries.every(entry => matches(entry.destination, entry.desired))) return false;
    const runtime = (dependencies.readText ?? readRecoveryMetadataText)(join(binding.userRoot, "runtime", "runtime-fingerprint.json"));
    if (runtime.state !== "present" || parseManagerStrictJsonObject(runtime.text).fingerprint !== binding.generation.runtimeFingerprint) return false;
    const ready = readText(join(binding.userRoot, "runtime-ready.json"));
    if (ready.state !== "present") return false;
    const receipt = parseManagerStrictJsonObject(ready.text);
    let accepted = readText(managerRuntimeAcceptancePath(managerRoot, operationId));
    if (accepted.state === "present" && canonicalManagerJson(parseManagerStrictJsonObject(accepted.text).receipt) !== canonicalManagerJson(receipt)) {
      accepted = readText(managerRuntimeAcceptanceAttemptPath(managerRoot, operationId, receipt));
    }
    if (accepted.state !== "present") return false;
    const proof = parseManagerStrictJsonObject(accepted.text);
    assertManagerExactObjectKeys(proof, ["schemaVersion", "kind", "expectation", "receipt", "pid", "processStartToken"], "Runtime acceptance");
    if (proof.schemaVersion !== 1 || proof.kind !== "tweakers-manager-runtime-acceptance"
      || canonicalManagerJson(proof.receipt) !== canonicalManagerJson(receipt)) return false;
    verifyRuntimeReadyReceiptBinding(proof.expectation as IndependentTweakersRuntimeReadyExpectation, receipt, proof.pid as number, proof.processStartToken as string);
    return receipt.operationId === operationId && receipt.promotionId === binding.promotionId
      && receipt.appRoot === binding.target && receipt.activePromotionReceiptSha256 === binding.generation.activeReceiptSha256
      && receipt.runtimeFingerprint === binding.generation.runtimeFingerprint;
  } catch { return false; }
}

/** Caller holds lifecycle.lock. Freeze verified history before a later promotion replaces its bytes. */
export function settleVerifiedManagerRecoveryOperations(
  managerRoot: string, store = new ManagerOperationStore(managerRoot), now = new Date().toISOString(),
  dependencies: RecoveryEvidenceDependencies = {},
  scope: {operationId?: string; beforeSettlement?: () => void} = {},
): string[] {
  let names: string[];
  try { names = readdirSync(store.paths.root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const settled: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || (scope.operationId && name !== `${scope.operationId}.json`)) continue;
    const record = store.read(name.slice(0, -5));
    if (!record || record.actionId !== "refresh.independent" || !["consumed", "recovery-required"].includes(record.phase)) continue;
    if(existsSync(join(managerRoot,"transactions","manager-recovery-bindings",`${record.operationId}.runtime-repair-head.json`))) {
      scope.beforeSettlement?.();
      if(settleAcceptedRuntimeRepair(record.operationId))settled.push(record.operationId);
      continue; // Never reinterpret an immutable app:promoted original as failed rollback.
    }
    const verified = managerOperationRecoveryIsVerified(managerRoot, record.operationId, {
      ...dependencies, expectedReceiptRefs: record.receiptRefs, consumedAt: record.consumedAt ?? undefined,
    });
    const binding = readManagerRecoveryBinding(managerRoot, record.operationId, dependencies.readText ?? readPrivateRecoveryText);
    if (!verified && (binding || !managerOperationHasSafePrepublicationFailure(record))) continue;
    let completed = false;
    if (verified && binding) {
      const read = (dependencies.readText ?? readPrivateRecoveryText)(binding.journal.path);
      if (read.state !== "present") throw new Error("Verified recovery journal disappeared before settlement");
      completed = parseManagerStrictJsonObject(read.text).phase === "committed";
    }
    scope.beforeSettlement?.();
    store.replace({ ...record, phase: completed ? "completed" : "failed", cancelledAt: null,
      completedAt: completed ? now : null, failedAt: completed ? null : now, recoveryRequiredAt: null,
      outcome: completed ? "verified-installation-accepted" : verified ? "verified-promotion-recovered" : "verified-prepublication-failure",
      error: completed ? null : record.error,
    });
    settled.push(record.operationId);
  }
  return settled;
}

function validateJournal(managerRoot: string, value: unknown, operationId: string): { id: string; userRoot: string; target: string; phase: string; entries: JournalEntry[]; activeReceipt: JournalEntry } {
  assertRoot(managerRoot);
  if (!isManagerJsonObject(value)) throw new Error("Recovery journal is invalid");
  assertManagerExactObjectKeys(value, ["version", "id", "userRoot", "target", "candidate", "buildRoot", "phase", "entries", "activeReceipt",
    ...(value.acceptedBackendTransition === undefined ? [] : ["acceptedBackendTransition"])], "Recovery journal");
  const userRoot = join(managerRoot, "variants", "tweakers"), target = "/Applications/Tweakers.app";
  const id = String(value.id); assertId(id);
  const buildRoot = join(userRoot, "builds", id), previous = join(userRoot, "previous", id), failed = join(buildRoot, "failed-promotion");
  const candidate = value.candidate;
  const doctorCandidate = typeof candidate === "string" && candidate.startsWith(join(managerRoot, "doctor", "jobs") + "/")
    && /^[a-f0-9-]{36}\/candidate\/Tweakers\.app$/.test(candidate.slice(join(managerRoot, "doctor", "jobs").length + 1));
  if (value.version !== 3 || value.userRoot !== userRoot || value.target !== target || value.buildRoot !== buildRoot
    || candidate !== join(dirname(target), `.${basename(target)}.candidate-${id}.app`) && !doctorCandidate
    || typeof value.phase !== "string" || !Array.isArray(value.entries) || value.entries.length !== ENTRY_NAMES.length) throw new Error("Recovery journal identity is invalid");
  if (value.acceptedBackendTransition !== undefined) {
    const binding = value.acceptedBackendTransition;
    if (!isManagerJsonObject(binding)) throw new Error("Recovery backend transition binding is invalid");
    assertManagerExactObjectKeys(binding, ["lane", "operationId"], "Recovery backend transition binding");
    assertAcceptedSharedNativeBackendTransitionShape(binding.lane);
    if (binding.operationId !== operationId || binding.lane.identity.target !== target || binding.lane.identity.userRoot !== userRoot
      || binding.lane.identity.brokerRoot !== join(managerRoot, "tweak-data", TWEAKERS_ACCOUNTS_TWEAK_ID)
      || value.phase === "recovered") throw new Error("Recovery backend transition operation or roots are invalid");
  }
  const entries = value.entries.map((entry, index) => {
    const name = ENTRY_NAMES[index]!;
    assertEntry(entry, ["name", "source", "destination", "archive", "failed", "hadDestination", "desired", "previous"]);
    const paths = name === "app"
      ? { source: candidate, destination: target, archive: join(previous, "app", basename(target)), failed: join(failed, "app", basename(target)) }
      : { source: join(buildRoot, name), destination: join(userRoot, name), archive: join(previous, "state", name), failed: join(failed, "state", name) };
    if (entry.name !== name || Object.entries(paths).some(([key, path]) => entry[key] !== path)) throw new Error("Recovery journal entry path is invalid");
    return entry as unknown as JournalEntry;
  });
  assertEntry(value.activeReceipt, ["source", "destination", "archive", "failed", "hadDestination", "desired", "previous", "expected"]);
  const active = value.activeReceipt;
  if (active.source !== join(buildRoot, "active-receipt.json") || active.destination !== join(userRoot, "transactions", "variant-promotion", "active.json")
    || active.archive !== join(previous, "active-receipt.json") || active.failed !== join(failed, "active-receipt.json")) throw new Error("Recovery receipt path is invalid");
  const expected = { version: 3, id, userRoot, target, entries: entries.filter(entry => entry.name !== "config.json").map(entry => ({ name: entry.name, path: entry.destination, fingerprint: entry.desired })) };
  if (canonicalManagerJson(active.expected) !== canonicalManagerJson(expected)) throw new Error("Recovery active receipt identity is invalid");
  return { id, userRoot, target, phase: value.phase, entries, activeReceipt: active as unknown as JournalEntry };
}
function assertEntry(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!isManagerJsonObject(value)) throw new Error("Recovery journal entry is invalid");
  assertManagerExactObjectKeys(value, keys, "Recovery journal entry");
  if (typeof value.hadDestination !== "boolean" || !validFingerprint(value.desired)
    || value.previous !== null && !validFingerprint(value.previous) || value.hadDestination !== (value.previous !== null)) throw new Error("Recovery journal fingerprints are invalid");
}
function validFingerprint(value: unknown): boolean {
  return isManagerJsonObject(value) && Object.keys(value).sort().join(",") === "kind,mode,sha256"
    && (value.kind === "file" || value.kind === "directory") && typeof value.mode === "number" && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777
    && typeof value.sha256 === "string" && HEX.test(value.sha256);
}
function assertRoot(root: string): void { if (root !== resolve(root) || !root.startsWith("/")) throw new Error("Recovery manager root must be an exact absolute path"); }
function assertId(id: string): void { if (!isManagerOperationId(id)) throw new Error("Recovery operation identity is invalid"); }
function assertPrivate(path: string, directory: boolean, sharedParent = false): void {
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || stat.uid !== process.getuid?.() || (stat.mode & (sharedParent ? 0o022 : 0o077)) !== 0 || (!directory && stat.nlink !== 1)) throw new Error("Recovery evidence path is unsafe");
}
function readPrivateRecoveryText(path: string): RecoveryTextRead {
  try {
    assertPrivate(path, false);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size > 64 * 1024) throw new Error("Recovery evidence is unsafe or exceeds its read limit");
      const text = readFileSync(fd, "utf8"), after = fstatSync(fd), current = lstatSync(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs
        || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) throw new Error("Recovery evidence changed during read");
      return { state: "present", text };
    } finally { closeSync(fd); }
  }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable", problem: "Recovery evidence is unsafe or unreadable" }; }
}
function definitelyAbsent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}
function readRecoveryMetadataText(path: string): RecoveryTextRead {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error("Unsafe recovery metadata");
    return { state: "present", text: readFileSync(path, "utf8") };
  } catch { return { state: "unreadable", problem: "Recovery metadata is unreadable" }; }
}

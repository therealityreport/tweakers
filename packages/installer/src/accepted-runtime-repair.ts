/** Forward-only repair of one accepted-backend operation. No caller-selected runtime authority. */
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { assertAcceptedRuntimeRepairHeadContract, assertAcceptedRuntimeRepairIntentContract, assertAcceptedRuntimeRepairPublicationContract,
  assertDoctorRuntimeRepairAuthorityContract,
  assertAcceptedRuntimeRepairConsumedApprovalContract, assertAcceptedRuntimeRepairOriginalCustodyContract, parseAcceptedRuntimeRepairJson,
  assertAcceptedRuntimeRepairAcceptanceSourceContract,
  assertAcceptedRuntimeRepairOriginalOperationProjection,
  supersededNativeReplacementOperationProjection, NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1,
  type AcceptedRuntimeRepairHead, type AcceptedRuntimeRepairIntent, type AcceptedRuntimeRepairPublicationV1,
  type DoctorRuntimeRepairAuthorityV2,
  type AcceptedRuntimeRepairOriginalCustodyV1, type AcceptedRuntimeRepairConsumedApprovalV1, type DoctorRuntimeRepairAuthority,
  type AcceptedRuntimeRepairWorkerCustodyV1, type AcceptedRuntimeRepairReadyBindingV1 } from "@therealityreport/tweakers-sdk";
import { codeSigningCertificateLeafHash, findExistingPreparedSigningIdentity, signCandidateReceiptResourceBundle, signatureInfo, verifyCandidateReceiptResourceBundle, verifySignature } from "./codesign.js";
import { canonicalTweakersManagerRoot, parseTweakersManagerTargetSeal, verifyRetainedTweakersManagerGeneration, TWEAKERS_MANAGER_LAUNCHER_NAME, TWEAKERS_MANAGER_SEAL_NAME, TWEAKERS_MANAGER_LAUNCHER_DESIGNATED_REQUIREMENT } from "./manager-descriptor.js";
import { isManagerOperationId, ManagerOperationStore } from "./manager-operation-store.js";
import { managerRecoveryJournalIdentitySha256, persistManagerRuntimeAcceptance, readManagerRecoveryBinding, readManagerAcceptedBackendRecoveryEvidence } from "./manager-recovery-evidence.js";
import { fingerprintVariantGeneration, type VariantGenerationFingerprint } from "./variant-generation.js";
import { canonicalManagerJson } from "./manager-contract.js";
import { doctorImplementationScopes } from "./doctor-implementation.js";
import { verifiedDoctorManagerLauncher } from "./doctor-actions.js";
import { readRuntimeFingerprintEvidence } from "./runtime-fingerprint.js";
import { cloneOrCopyDirectoryPreservingModes } from "./fs-copy.js";
import { assertAcceptedAccountsRecoveryRuntime, prepareProbedAccountsTransferRecovery } from "./accounts-transfer-compatibility.js";
import { readRuntimeRepairSourceCustody, reviewRuntimeRepairGeneratedDelta, RUNTIME_REPAIR_SOURCE_CUSTODY_FILE } from "./runtime-repair-source-custody.js";
import { assertAcceptedSharedNativeBackendTransitionShape, assertAcceptedSharedNativeBackendTransitionClosure, assertAcceptedSharedNativeBackendTransitionPairClosure, sharedNativeBackendTransitionPort, prepareOfficialBundledBackendTransitionRequest, type AcceptedSharedNativeBackendTransitionRequestV2, type AcceptedBackendTransitionJournalBindingV1, type AcceptedBackendTransitionJournalBinding } from "./shared-native-backend-transition.js";
import { defaultTweakersAccountsBrokerRoot } from "./macos-variant.js";
import { targetUserHome } from "./ownership.js";
import { inspectLocalArtifactCapacity, publishLocalArtifactSnapshot, readReservations, retireLocalArtifactAt } from "./local-artifacts.js";
import type { TweakersManagerPreparedOperationV1 } from "./manager-contract.js";
import { assertIndependentTweakersRuntimeReadyExpectation, verifyRuntimeReadyReceiptBinding, type IndependentTweakersRuntimeReadyExpectation } from "./runtime-ready-receipt.js";
import type { DeferredTweakersVariantRefresh } from "./commands/create-variant.js";
import { verifyIndependentTweakersRuntimeReadyReceipt } from "./commands/create-variant.js";

export interface AcceptedRuntimeRepairFileRef { path: string; sha256: string }
export interface AcceptedRuntimeRepairOriginalCustody {
  managerRoot: string; operationId: string; promotionId: string; userRoot: string; target: string;
  trustedLeafSha1: string;
  worker: { generationId: string; launcherPath: string; launcherSha256: string; sealSha256: string; nodePath: string; nodeSha256: string; moduleRoot: string; runtimeRoot: string };
  files: { operation: AcceptedRuntimeRepairFileRef; recoveryBinding: AcceptedRuntimeRepairFileRef; journal: AcceptedRuntimeRepairFileRef;
    expectation: AcceptedRuntimeRepairFileRef; candidateReceipt: AcceptedRuntimeRepairFileRef; signedReceiptBundle: string;
    preparedCasIntent: AcceptedRuntimeRepairFileRef; completedCas: AcceptedRuntimeRepairFileRef; priorRegistration: AcceptedRuntimeRepairFileRef; registration: AcceptedRuntimeRepairFileRef };
  binding: AcceptedBackendTransitionJournalBindingV1;
  generations: { app: VariantGenerationFingerprint; runtime: VariantGenerationFingerprint; tweaks: VariantGenerationFingerprint; state: VariantGenerationFingerprint; config: VariantGenerationFingerprint; priorActiveReceipt: VariantGenerationFingerprint };
}

const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const fail: (reason: string) => never = (reason: string): never => { throw new Error(`Accepted runtime repair: ${reason}`); };

export function acceptedRuntimeRepairHeadPath(operationId: string): string {
  if (!isManagerOperationId(operationId)) fail("invalid original operation");
  return join(canonicalTweakersManagerRoot(), "transactions", "manager-recovery-bindings", `${operationId}.runtime-repair-head.json`);
}

export interface AcceptedRuntimeRepairRecord {
  root: string; head: AcceptedRuntimeRepairHead; intent: AcceptedRuntimeRepairIntent;
  publication: AcceptedRuntimeRepairPublicationV1; readyBinding: AcceptedRuntimeRepairReadyBindingV1;
}

/** Structural/byte custody only. This never authorizes staging, startup or settlement. */
export function readAcceptedRuntimeRepairRecord(operationId: string): AcceptedRuntimeRepairRecord | null {
  const managerRoot = canonicalTweakersManagerRoot(), headPath = acceptedRuntimeRepairHeadPath(operationId);
  let raw: Buffer;
  try { raw = readAcceptedRuntimeRepairPrivateFile(managerRoot, headPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return runtimeRepairRecordFromHeadBytes(operationId,raw);
}
function runtimeRepairRecordFromHeadBytes(operationId:string,raw:Buffer):AcceptedRuntimeRepairRecord {
  const managerRoot=canonicalTweakersManagerRoot();
  const head: unknown = parseAcceptedRuntimeRepairJson(raw.toString("utf8"));
  assertAcceptedRuntimeRepairHeadContract(head);
  if (head.operationId !== operationId) fail("head crosses the original operation");
  const root = join(managerRoot, "variants", "tweakers", "builds", head.promotionId, "runtime-repair", "accepted", "operations", head.repairId);
  assertAcceptedRuntimeRepairPrivatePath(join(managerRoot, "variants", "tweakers"), root, true);
  const intentBytes = readAcceptedRuntimeRepairPrivateFile(root, join(root, "intent.json"));
  if (sha(intentBytes) !== head.intentSha256 || !raw.equals(readAcceptedRuntimeRepairPrivateFile(root, join(root, "head.json")))) fail("authoritative head/intent bytes differ");
  const intent: unknown = parseAcceptedRuntimeRepairJson(intentBytes.toString("utf8"));
  const deps = {isCanonicalAbsolutePath: (path: string) => path === resolve(path) && path.startsWith("/"), sha256: (text: string) => sha(text)};
  assertAcceptedRuntimeRepairIntentContract(intent, deps);
  if (intent.operationId !== operationId || intent.promotionId !== head.promotionId || intent.repairId !== head.repairId || intent.version !== head.version || !isDeepStrictEqual(intent.prior,head.prior)) fail("intent is foreign or changes predecessor");
  const authority = intent.authority;
  if(authority.version===2) {
    const challenge=repairJson(root,authority.predecessor.challenge.snapshot.path);
    if(Date.parse(intent.createdAt)<Date.parse(challenge.createdAt))fail("successor intent predates captured predecessor challenge");
  }
  for (const [ref, name] of [[authority.originals.operation.snapshot, "original-operation.json"], [authority.originals.journal.snapshot, "original-journal.json"],
    [authority.originals.expectation.snapshot, "original-expectation.json"], [authority.originals.custody, "original-custody.json"],
    [intent.consumedApproval, "consumed-doctor-approval.json"], [intent.effectiveJournal, "effective-journal.json"],
    [intent.effectiveActiveReceipt, "effective-active-receipt.json"]] as const) {
    if (ref.path !== join(root, name) || sha(readAcceptedRuntimeRepairPrivateFile(root, ref.path)) !== ref.sha256) fail(`immutable ${name} binding differs`);
  }
  for (const origin of [authority.originals.operation, authority.originals.journal, authority.originals.expectation]) {
    if (origin.sourceSha256AtCapture !== origin.snapshot.sha256) fail("original snapshot is not its exact captured source");
  }
  if (authority.originals.operation.sourcePath !== join(managerRoot, "transactions", "manager-operations", `${operationId}.json`)
    || authority.originals.journal.sourcePath !== join(managerRoot, "variants", "tweakers", "transactions", "variant-promotion", `${head.promotionId}.json`)
    || authority.originals.expectation.sourcePath !== join(managerRoot, "variants", "tweakers", "runtime-ready-expectation.json")) fail("mutable original source paths are foreign");
  const publication: unknown = parseAcceptedRuntimeRepairJson(readAcceptedRuntimeRepairPrivateFile(root, join(root, "publication.json")).toString("utf8"));
  assertAcceptedRuntimeRepairPublicationContract(publication);
  if (publication.operationId !== operationId || publication.promotionId !== head.promotionId || publication.repairId !== head.repairId
    || publication.intentSha256 !== head.intentSha256) fail("publication identity differs");
  return {root, head, intent, publication, readyBinding: {repairId: head.repairId, headSha256: sha(raw),
    intentSha256: head.intentSha256, authorityReceiptSha256: intent.authorityReceipt.jsonSha256}};
}

function predecessorRecord(authority:DoctorRuntimeRepairAuthorityV2):AcceptedRuntimeRepairRecord {
  const managerRoot=canonicalTweakersManagerRoot(),binding=authority.predecessor.binding;
  const root=join(managerRoot,"variants","tweakers","builds",authority.promotionId,"runtime-repair","accepted","operations",binding.repairId);
  const raw=readAcceptedRuntimeRepairPrivateFile(root,join(root,"head.json"));
  if(sha(raw)!==binding.headSha256)fail("predecessor head changed");
  const record=runtimeRepairRecordFromHeadBytes(authority.operationId,raw);
  if(record.head.version!==1||record.intent.version!==1||record.head.promotionId!==authority.promotionId||record.head.repairId===authority.repairId
    ||record.head.intentSha256!==binding.intentSha256||record.intent.authorityReceipt.jsonSha256!==binding.authorityReceiptSha256
    ||record.publication.phase!=="challenge:published"||authority.predecessor.publication.path!==join(root,"publication.json"))fail("successor requires exactly one unaccepted initial challenge");
  assertRef(root,authority.predecessor.publication);
  return record;
}
function assertPredecessorAcceptanceAbsent(record:AcceptedRuntimeRepairRecord,managerRoot=canonicalTweakersManagerRoot()):void {
  if(existsSync(join(record.root,"acceptance.json"))||existsSync(join(record.root,"acceptance-source.json")))fail("predecessor already has acceptance custody");
  const directory=join(managerRoot,"transactions","manager-recovery-bindings"),id=record.head.operationId;
  for(const name of readdirSync(directory)) {
    if(name!==`${id}.acceptance.json`&&!new RegExp(`^${id}\\.acceptance\\.[a-f0-9]{64}\\.json$`).test(name))continue;
    const proof=repairJson(managerRoot,join(directory,name));
    assertRuntimeRepairAcceptanceAttempt(proof,id,name);
    if(proof.expectation.runtimeRepair?.repairId===record.head.repairId||proof.receipt.runtimeRepair?.repairId===record.head.repairId)fail("predecessor has genuine maintained acceptance");
  }
}
/** The same maintained readiness validators used for real acceptance; this
 * validates historical custody only, never current process liveness. */
function assertRuntimeRepairAcceptanceAttempt(proof:unknown,operationId:string,name:string):asserts proof is {
  schemaVersion:1;kind:string;expectation:IndependentTweakersRuntimeReadyExpectation;
  receipt:import("./runtime-ready-receipt.js").IndependentTweakersRuntimeReadyReceipt;pid:number;processStartToken:string
} {
  if(!proof||typeof proof!=="object"||Array.isArray(proof)
    ||Object.keys(proof).sort().join(",")!==["schemaVersion","kind","expectation","receipt","pid","processStartToken"].sort().join(","))fail("maintained acceptance attempt is malformed");
  const value=proof as Record<string,any>;
  if(value.schemaVersion!==1||value.kind!=="tweakers-manager-runtime-acceptance")fail("maintained acceptance attempt is malformed");
  assertIndependentTweakersRuntimeReadyExpectation(value.expectation);
  verifyRuntimeReadyReceiptBinding(value.expectation,value.receipt,value.pid,value.processStartToken);
  for(const key of ["promotionId","activePromotionReceiptSha256","appRoot","bundleId","appAsarHeaderHash","runtimeFingerprint","appUserDataRoot","codexHomeRoot","accountsBrokerRoot","brokerAuthorityExpectation"] as const)
    if(!isDeepStrictEqual(value.receipt[key],value.expectation[key]))fail("maintained acceptance attempt exact identity differs");
  if(value.expectation.operationId!==operationId||Date.parse(value.receipt.observedAt)<Date.parse(value.expectation.createdAt)
    ||name!==`${operationId}.acceptance.json`&&name!==`${operationId}.acceptance.${sha(canonicalManagerJson(value.receipt))}.json`)
    fail("maintained acceptance attempt identity, chronology or filename differs");
}
/** Explicit filesystem fixture port for the actual prepublication boundary. */
export function assertAcceptedRuntimeRepairPredecessorAcceptanceAbsentForTest(managerRoot:string,record:AcceptedRuntimeRepairRecord):void {
  assertPredecessorAcceptanceAbsent(record,managerRoot);
}
function assertPredecessorChallenge(record:AcceptedRuntimeRepairRecord,challenge:unknown):void {
  const original=repairJson(record.root,record.intent.authority.originals.expectation.snapshot.path);
  assertIndependentTweakersRuntimeReadyExpectation(challenge);
  const value=challenge as IndependentTweakersRuntimeReadyExpectation;
  const expected={...original,schemaVersion:6,runtimeRepair:record.readyBinding,runtimeFingerprint:record.intent.authority.repairedRuntime.evidence.fingerprint,
    activePromotionReceiptSha256:fingerprintVariantGeneration(record.intent.effectiveActiveReceipt.path).sha256,createdAt:value.createdAt};
  if(!isDeepStrictEqual(value,expected)||Date.parse(value.createdAt)<Date.parse(record.intent.createdAt))fail("predecessor challenge is not exact signed authority");
}
function assertSuccessorAdmission(record:AcceptedRuntimeRepairRecord):void {
  if(record.head.version!==1||record.intent.version!==1||record.publication.phase!=="challenge:published"
    ||new ManagerOperationStore(canonicalTweakersManagerRoot()).read(record.head.operationId)?.phase!=="recovery-required")fail("only an unaccepted V1 challenge permits one successor");
  assertPreparedRuntimeRepairAuthority(record.root,record.intent.authority,true);
  assertPredecessorAcceptanceAbsent(record);
  const journal=originalRepairJournal(record.root,record.intent.authority);
  assertGeneration(journal.activeReceipt.destination,record.intent.authority.unchanged.priorActiveReceipt);
  assertRepairedRuntime(record,join(journal.userRoot,"runtime"));
  assertGeneration(join(record.root,"prior-runtime"),record.intent.authority.priorRuntime);
  assertPredecessorChallenge(record,repairJson(canonicalTweakersManagerRoot(),join(journal.userRoot,"runtime-ready-expectation.json")));
}

/** Reads only retained bytes; no original/candidate JavaScript is executed. */
export function readAcceptedRuntimeRepairOriginalCustody(operationId: string): AcceptedRuntimeRepairOriginalCustody {
  if (!isManagerOperationId(operationId)) fail("invalid original operation");
  if (readAcceptedRuntimeRepairRecord(operationId) !== null) fail("an authoritative child exists; resume or settle that exact child");
  const managerRoot = canonicalTweakersManagerRoot();
  assertAcceptedRuntimeRepairPrivatePath(managerRoot, managerRoot, true);
  const operation = new ManagerOperationStore(managerRoot).read(operationId);
  if (!operation || operation.actionId !== "refresh.independent" || operation.phase !== "recovery-required" || !operation.consumedAt
    || operation.moduleIdentity.state !== "resolved" || !operation.moduleIdentity.path || !operation.moduleIdentity.sha256) fail("original consumed recovery operation is required");
  const recoveryBinding = readManagerRecoveryBinding(managerRoot, operationId);
  if (!recoveryBinding || !isDeepStrictEqual(operation.receiptRefs, recoveryBinding.receiptRefs)) fail("original recovery binding changed");
  const journalPath = recoveryBinding.journal.path;
  const journal = JSON.parse(readAcceptedRuntimeRepairPrivateFile(managerRoot, journalPath).toString("utf8"));
  if (journal.id !== recoveryBinding.promotionId || journal.phase !== "app:promoted" || journal.target !== recoveryBinding.target
    || journal.userRoot !== recoveryBinding.userRoot || managerRecoveryJournalIdentitySha256(journal) !== recoveryBinding.journal.identitySha256
    || !journal.acceptedBackendTransition) fail("original provisional journal differs");
  const observedBinding = journal.acceptedBackendTransition as AcceptedBackendTransitionJournalBinding;
  assertAcceptedSharedNativeBackendTransitionShape(observedBinding.lane);
  if (observedBinding.lane.version !== 1) fail("original repair requires the historical accepted-build lane");
  const binding: AcceptedBackendTransitionJournalBindingV1 = { ...observedBinding, lane: observedBinding.lane };
  if (binding.operationId !== operationId) fail("original transition operation differs");

  const launcherPath = operation.moduleIdentity.path;
  const generationId = basename(dirname(launcherPath));
  const expectedLauncher = join(managerRoot, "managers", "com.thomashulihan.tweakers", "generations", generationId, TWEAKERS_MANAGER_LAUNCHER_NAME);
  if (launcherPath !== expectedLauncher || sha(readAcceptedRuntimeRepairRegularFile(launcherPath)) !== operation.moduleIdentity.sha256) fail("original launcher changed");
  const retained = verifyRetainedTweakersManagerGeneration(generationId);
  const sealPath = join(dirname(launcherPath), TWEAKERS_MANAGER_SEAL_NAME);
  const seal = parseTweakersManagerTargetSeal(readAcceptedRuntimeRepairRegularFile(sealPath).toString("utf8"));
  if (seal.launcherSha256 !== operation.moduleIdentity.sha256 || seal.generationId !== generationId) fail("original seal differs");
  // The original independently signature-verified sealed module, not the new
  // child or newly edited source, establishes the supported local leaf pin.
  const retainedModule = readAcceptedRuntimeRepairRegularFile(join(retained.moduleRoot, "manager-descriptor.js")).toString("utf8");
  const requirement = /const PINNED_MANAGER_DESIGNATED_REQUIREMENT\s*=\s*'([^'\n]+)'/.exec(retainedModule)?.[1];
  const trustedLeafSha1 = /^identifier "com\.therealityreport\.tweakers\.manager-launcher" and certificate leaf = H"([a-f0-9]{40})"$/.exec(requirement ?? "")?.[1]?.toUpperCase();
  if (!trustedLeafSha1 || codeSigningCertificateLeafHash(launcherPath) !== trustedLeafSha1 || !verifySignature(launcherPath, trustedLeafSha1).ok) fail("original independent signer anchor is unavailable");

  const appEntry = journal.entries?.find((entry: { name: string }) => entry.name === "app");
  const runtimeEntry = journal.entries?.find((entry: { name: string }) => entry.name === "runtime");
  const candidateRoot = dirname(appEntry?.source ?? "");
  const jobId = basename(dirname(candidateRoot));
  if (!isManagerOperationId(jobId) || candidateRoot !== join(managerRoot, "doctor", "jobs", jobId, "candidate")) fail("original signed candidate custody is not canonical");
  const signedReceiptBundle = join(candidateRoot, "receipt", "TweakersCandidateReceipt.bundle");
  verifyCandidateReceiptResourceBundle(signedReceiptBundle, trustedLeafSha1);
  const candidateReceipt = join(signedReceiptBundle, "Contents", "Resources", "variant-candidate-receipt.json");
  const receipt = JSON.parse(readAcceptedRuntimeRepairRegularFile(candidateReceipt).toString("utf8"));
  const state = JSON.parse(readAcceptedRuntimeRepairPrivateFile(managerRoot, join(recoveryBinding.userRoot, "state.json")).toString("utf8"));
  if (receipt.signingIdentityHash !== trustedLeafSha1 || state.signingIdentityHash !== trustedLeafSha1
    || !isDeepStrictEqual(receipt.acceptedBackendTransition, binding.lane)
    || !isDeepStrictEqual(receipt.artifacts?.app, appEntry.desired)
    || codeSigningCertificateLeafHash(recoveryBinding.target) !== trustedLeafSha1 || !verifySignature(recoveryBinding.target, trustedLeafSha1).ok) fail("original signed desktop custody changed");
  assertGeneration(recoveryBinding.target, appEntry.desired);
  assertGeneration(join(recoveryBinding.userRoot, "runtime"), runtimeEntry.desired);
  assertAcceptedSharedNativeBackendTransitionClosure(binding.lane, recoveryBinding.target, join(recoveryBinding.userRoot, "runtime"));

  const buildRoot = join(recoveryBinding.userRoot, "builds", recoveryBinding.promotionId);
  const preparedCasIntent = join(buildRoot, "accepted-backend-transition", "intent.json");
  const cas = JSON.parse(readAcceptedRuntimeRepairPrivateFile(managerRoot, preparedCasIntent).toString("utf8"));
  if (cas.journalPath !== journalPath || sha(cas.preparedJournalBytes) !== cas.preparedJournalSha256
    || !isDeepStrictEqual(JSON.parse(cas.preparedJournalBytes), { ...journal, phase: "prepared" })) fail("original immutable CAS journal changed");
  const planHash = cas.planFingerprint?.replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(planHash)) fail("original CAS fingerprint is invalid");
  const brokerRoot = binding.lane.identity.brokerRoot;
  const completedCas = join(brokerRoot, `shared-native-resolver-completed-${planHash}.json`);
  const priorRegistration = join(brokerRoot, `shared-native-resolver-prior-${planHash}.json`);
  const registration = join(brokerRoot, "shared-native-mode.v1.json");
  if (sha(readAcceptedRuntimeRepairPrivateFile(managerRoot, completedCas)) !== planHash
    || `sha256:${sha(readAcceptedRuntimeRepairPrivateFile(managerRoot, priorRegistration))}` !== binding.lane.priorRegistrationFingerprint) fail("completed CAS custody changed");
  const validation = sharedNativeBackendTransitionPort(retained.runtimeRoot).executeSharedNativeResolverTransitionAtRootV1({stateRoot: brokerRoot,
    plan: cas.plan, expectedPlanFingerprint: cas.planFingerprint, action: "validate"});
  if (validation.state !== "validated" || validation.resolverBinarySha256 !== binding.lane.authority.backend.sha256) fail("completed signed registration is not valid");
  const ref = (path: string): AcceptedRuntimeRepairFileRef => ({path, sha256: sha(readAcceptedRuntimeRepairRegularFile(path))});
  const generation = (name: string): VariantGenerationFingerprint => {
    const entry = journal.entries.find((entry: { name: string }) => entry.name === name);
    if (!entry) fail(`original ${name} identity is absent`);
    assertGeneration(entry.destination, entry.desired); return entry.desired;
  };
  assertGeneration(journal.activeReceipt.destination, journal.activeReceipt.previous);
  return { managerRoot, operationId, promotionId: recoveryBinding.promotionId, userRoot: recoveryBinding.userRoot, target: recoveryBinding.target,
    trustedLeafSha1, worker: {generationId, launcherPath, launcherSha256: seal.launcherSha256, sealSha256: retained.sealSha256,
      nodePath: seal.nodePath, nodeSha256: seal.nodeSha256, moduleRoot: retained.moduleRoot, runtimeRoot: retained.runtimeRoot},
    files: {operation: ref(join(managerRoot, "transactions", "manager-operations", `${operationId}.json`)),
      recoveryBinding: ref(join(managerRoot, "transactions", "manager-recovery-bindings", `${operationId}.json`)), journal: ref(journalPath),
      expectation: ref(join(recoveryBinding.userRoot, "runtime-ready-expectation.json")), candidateReceipt: ref(candidateReceipt), signedReceiptBundle,
      preparedCasIntent: ref(preparedCasIntent), completedCas: ref(completedCas), priorRegistration: ref(priorRegistration), registration: ref(registration)},
    binding, generations: { app: appEntry.desired, runtime: runtimeEntry.desired, tweaks: generation("tweaks"), state: generation("state.json"),
      config: generation("config.json"), priorActiveReceipt: journal.activeReceipt.previous} };
}

function assertGeneration(path: string, expected: VariantGenerationFingerprint): void {
  if (!isDeepStrictEqual(fingerprintVariantGeneration(path), expected)) fail(`generation changed at ${path}`);
}

/** No redirect, archive, foreign owner, public evidence or linked ancestor. */
export function assertAcceptedRuntimeRepairPrivatePath(root: string, path: string, directory: boolean): void {
  if (root !== resolve(root) || path !== resolve(path) || (path !== root && !path.startsWith(root + "/")) || realpathSync(root) !== root) fail("evidence path is not canonical custody");
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const status = lstatSync(cursor);
    if (status.isSymbolicLink() || status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0
      || ((cursor !== path || directory) ? !status.isDirectory() : !status.isFile())) fail("evidence is not owner-private and unlinked");
    if (cursor === root) break;
  }
}

export function readAcceptedRuntimeRepairPrivateFile(root: string, path: string): Buffer {
  // Original shared transaction parents may predate private repair evidence.
  // Preserve their modes: reject writable/linked parents; require the leaf private.
  if (root !== resolve(root) || path !== resolve(path) || !path.startsWith(root + "/") || realpathSync(root) !== root) fail("original evidence escaped canonical custody");
  for (let cursor = dirname(path); ; cursor = dirname(cursor)) {
    const status = lstatSync(cursor);
    if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== process.getuid?.() || (status.mode & 0o022) !== 0) fail("original evidence ancestry is unsafe");
    if (cursor === root) break;
  }
  const status = lstatSync(path);
  if ((status.mode & 0o077) !== 0) fail("original evidence leaf is not private");
  return readAcceptedRuntimeRepairRegularFile(path);
}

function readAcceptedRuntimeRepairRegularFile(path: string): Buffer {
  if (realpathSync(path) !== path) fail("retained file is linked");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size > 32 * 1024 * 1024) fail("retained file is unsafe");
    const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs
      || before.dev !== named.dev || before.ino !== named.ino || named.isSymbolicLink()) fail("retained file changed during read");
    return bytes;
  } finally { closeSync(fd); }
}

export interface AcceptedRuntimeRepairDoctorReportV1 {
  version: 1; kind: "tweakers-doctor-runtime-repair-report";
  operationId: string; promotionId: string; repairId: string; jobId: string;
  workerGenerationId: string; originalJournalSha256: string; validationFingerprint: string;
  candidateFingerprint: string; adoptionFingerprint: string; promotionFingerprint: string;
  reviewedDeltaSha256: string; fingerprint: string;
}
const fingerprint = (value: unknown): string => `sha256:${sha(canonicalManagerJson(value))}`;
const contractDependencies = {isCanonicalAbsolutePath:(path:string)=>path === resolve(path) && path.startsWith("/"),sha256:(text:string)=>sha(text)};
const REPAIR_RECEIPT_IDENTIFIER = "co.tweakers.accepted-runtime-repair";

/** Projection is shared with genuine producer fixtures; it grants no authority. */
export function createAcceptedRuntimeRepairEffectiveActiveReceipt(original: {activeReceipt:{expected:Record<string,any>}},
  repairId: string, authorityReceiptSha256: string, repaired: VariantGenerationFingerprint): Record<string,unknown> {
  return {...original.activeReceipt.expected,version:4,runtimeRepair:{repairId,authorityReceiptSha256},
    entries:original.activeReceipt.expected.entries.map((entry: {name:string})=>entry.name === "runtime" ? {...entry,fingerprint:repaired} : entry)};
}
export function createAcceptedRuntimeRepairEffectiveJournal(original: Record<string,any>, root: string,
  repaired: VariantGenerationFingerprint, activeReceipt: unknown, activeGeneration: VariantGenerationFingerprint): Record<string,unknown> {
  return {...original,phase:"committed",entries:original.entries.map((entry:{name:string})=>entry.name === "runtime" ? {...entry,desired:repaired}:entry),
    activeReceipt:{...original.activeReceipt,source:join(root,"effective-active-receipt.json"),archive:join(root,"prior-active-receipt.json"),
      failed:join(root,"failed-active-receipt.json"),desired:activeGeneration,expected:activeReceipt}};
}

function privateDirectoryTree(root:string, path:string):void {
  if (root !== resolve(root) || path !== resolve(path) || !path.startsWith(root+"/") || realpathSync(root)!==root) fail("allocation escaped canonical root");
  const missing:string[]=[]; let current=path;
  for (;;) {
    try { lstatSync(current); break; } catch(error) {if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; missing.push(current);current=dirname(current);}
    if (current !== root && !current.startsWith(root+"/")) fail("allocation has no retained root");
  }
  assertAcceptedRuntimeRepairPrivatePath(root,current,true);
  for (const entry of missing.reverse()) {
    withinPinnedRepairDirectory(root,dirname(entry),(assertCurrent,fd)=>{
      assertCurrent();mkdirSync(basename(entry),{mode:0o700});fsyncSync(fd);
    });
    if(realpathSync(entry)!==entry)fail("allocation ancestry changed; preserve evidence");
    assertAcceptedRuntimeRepairPrivatePath(root,entry,true);
    syncDirectory(dirname(entry));
  }
}
function syncDirectory(path:string):void {const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
/** Synchronous leaf operations use the kernel-held cwd after checking its
 * retained directory identity. A rejected ancestor can never redirect them. */
function withinPinnedRepairDirectory<T>(root:string,path:string,operation:(assertCurrent:()=>void,fd:number)=>T):T {
  assertAcceptedRuntimeRepairPrivatePath(root,path,true);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),original=fstatSync(fd);
  const previous=realpathSync(process.cwd()),previousStatus=lstatSync(previous);
  const assertCurrent=()=>{
    assertAcceptedRuntimeRepairPrivatePath(root,path,true);
    const named=lstatSync(path),pinned=fstatSync(fd);
    if(named.dev!==original.dev||named.ino!==original.ino||pinned.dev!==original.dev||pinned.ino!==original.ino
      ||named.uid!==original.uid||named.gid!==original.gid||named.mode!==original.mode)fail("retained publication directory changed");
  };
  let entered=false;
  try {
    assertCurrent();process.chdir(path);entered=true;
    const actual=lstatSync(".");
    if(actual.dev!==original.dev||actual.ino!==original.ino)fail("publication directory changed before entry");
    const value=operation(assertCurrent,fd);
    if(value&&typeof(value as {then?:unknown}).then==="function")fail("asynchronous pinned publication is forbidden");
    assertCurrent();return value;
  }finally {
    try {if(entered){process.chdir(previous);const restored=lstatSync(".");if(restored.dev!==previousStatus.dev||restored.ino!==previousStatus.ino)fail("original working directory changed");}}
    finally{closeSync(fd);}
  }
}
/** Only fresh child staging directories become writable; sealed files retain
 * their exact modes/bytes. The clone's clear/copy sinks stay at a retained cwd. */
function prepareRuntimeRepairStaging(root:string,source:string,afterCopy?:()=>void):string {
  const next=join(root,"next-runtime"),before=fingerprintVariantGeneration(source),baseline=runtimeAuthority(source);
  withinPinnedRepairDirectory(root,root,(assertCurrent,parentFd)=>{
    if(existsSync("next-runtime"))fail("fresh staging output already exists");
    assertCurrent();cloneOrCopyDirectoryPreservingModes(source,"next-runtime");
    afterCopy?.();assertCurrent();
    const makeDirectoriesWritable=(path:string):void=>{
      const previous=realpathSync("."),previousStatus=lstatSync("."),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      let entered=false;
      try {
        const original=fstatSync(fd),named=lstatSync(path);
        if(!original.isDirectory()||original.uid!==process.getuid?.()||named.dev!==original.dev||named.ino!==original.ino)fail("fresh staging directory changed");
        process.chdir(path);entered=true;
        const current=lstatSync(".");if(current.dev!==original.dev||current.ino!==original.ino)fail("fresh staging directory replaced before entry");
        // Each descendant open is a basename relative to its retained parent,
        // never a pathname through an ancestor another writer can redirect.
        for(const name of readdirSync(".")) {
          const status=lstatSync(name);
          if(status.isSymbolicLink()||(!status.isDirectory()&&!status.isFile()))fail("fresh staging contains unsupported entries");
          if(status.isDirectory())makeDirectoriesWritable(name);
        }
        assertCurrent();const pinned=fstatSync(fd),actual=lstatSync(".");
        if(actual.dev!==original.dev||actual.ino!==original.ino||pinned.dev!==original.dev||pinned.ino!==original.ino)fail("fresh staging directory replaced");
        fchmodSync(fd,0o700);fsyncSync(fd);
      }finally{
        try{if(entered){process.chdir(previous);const restored=lstatSync(".");if(restored.dev!==previousStatus.dev||restored.ino!==previousStatus.ino)fail("fresh staging parent changed");}}
        finally{closeSync(fd);}
      }
    };
    makeDirectoriesWritable("next-runtime");assertCurrent();fsyncSync(parentFd);
  });
  assertGeneration(source,before);
  if(!isDeepStrictEqual(runtimeAuthority(next),{...baseline,sourceRoot:next}))fail("fresh staging changed baseline bytes or document");
  return next;
}
/** Explicit test-only fault port; production scan uses the same fixed derivation. */
export function prepareAcceptedRuntimeRepairStagingForTest(root:string,source:string,afterCopy?:()=>void):string {
  return prepareRuntimeRepairStaging(root,source,afterCopy);
}

/** Never deletes a temporary file on failure; retained bytes are recovery evidence. */
function writeImmutableRepairFile(root:string,path:string,bytes:Buffer|string):AcceptedRuntimeRepairFileRef {
  if(path!==resolve(path)||!path.startsWith(root+"/"))fail("immutable publication escaped root");
  return withinPinnedRepairDirectory(root,dirname(path),(assertCurrent,parentFd)=>{
    const fd=openSync(basename(path),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {
      writeFileSync(fd,bytes);fsyncSync(fd);
      const opened=fstatSync(fd),named=lstatSync(basename(path));
      if(!opened.isFile()||opened.nlink!==1||opened.uid!==process.getuid?.()||(opened.mode&0o777)!==0o600
        ||opened.dev!==named.dev||opened.ino!==named.ino)fail("immutable publication leaf changed");
      assertCurrent();fsyncSync(parentFd);return{path,sha256:sha(bytes)};
    }finally{closeSync(fd);}
  });
}
function immutableJson(root:string,path:string,value:unknown):AcceptedRuntimeRepairFileRef {return writeImmutableRepairFile(root,path,`${JSON.stringify(value)}\n`);}
function snapshot(root:string,name:string,origin:AcceptedRuntimeRepairFileRef):{sourcePath:string;sourceSha256AtCapture:string;snapshot:AcceptedRuntimeRepairFileRef} {
  const raw=readAcceptedRuntimeRepairRegularFile(origin.path);if(sha(raw)!==origin.sha256)fail("origin changed before snapshot");
  return {sourcePath:origin.path,sourceSha256AtCapture:origin.sha256,snapshot:writeImmutableRepairFile(root,join(root,name),raw)};
}

function workerCustody(launcher:string,trustedLeaf:string):{worker:AcceptedRuntimeRepairWorkerCustodyV1;moduleRoot:string;runtimeRoot:string} {
  const managerRoot=canonicalTweakersManagerRoot(),generationId=basename(dirname(launcher));
  if (!/^[a-f0-9]{64}$/.test(generationId) || launcher!==join(managerRoot,"managers","com.thomashulihan.tweakers","generations",generationId,TWEAKERS_MANAGER_LAUNCHER_NAME))fail("worker is not the fixed retained launcher");
  const retained=verifyRetainedTweakersManagerGeneration(generationId),sealBytes=readAcceptedRuntimeRepairRegularFile(join(dirname(launcher),TWEAKERS_MANAGER_SEAL_NAME));
  const seal=parseTweakersManagerTargetSeal(sealBytes.toString("utf8"));
  if (sha(sealBytes)!==retained.sealSha256 || seal.generationId!==generationId || sha(readAcceptedRuntimeRepairRegularFile(launcher))!==seal.launcherSha256
    || realpathSync(process.execPath)!==seal.nodePath || sha(readFileSync(seal.nodePath))!==seal.nodeSha256
    || codeSigningCertificateLeafHash(launcher)!==trustedLeaf || !verifySignature(launcher,trustedLeaf).ok)fail("worker/Node differs from exact trusted custody");
  const implementationScopes=doctorImplementationScopes(retained.moduleRoot,retained.runtimeRoot);
  if (sha(readAcceptedRuntimeRepairRegularFile(join(dirname(launcher),TWEAKERS_MANAGER_SEAL_NAME)))!==retained.sealSha256)fail("worker changed while scopes were read");
  return {worker:{generationId,launcherPath:launcher,launcherSha256:seal.launcherSha256,sealSha256:retained.sealSha256,nodePath:seal.nodePath,nodeSha256:seal.nodeSha256,implementationScopes},
    moduleRoot:retained.moduleRoot,runtimeRoot:retained.runtimeRoot};
}
function assertCurrentRepairWorker(authorized:{worker:AcceptedRuntimeRepairWorkerCustodyV1;moduleRoot:string}):void {
  const executed=fileURLToPath(import.meta.url);
  if(executed!==join(authorized.moduleRoot,"accepted-runtime-repair.js")&&executed!==join(dirname(authorized.worker.launcherPath),"manager.mjs"))
    fail("repair engine is not executing from the authorized sealed worker");
}
function runtimeAuthority(sourceRoot:string):DoctorRuntimeRepairAuthority["repairedBaseline"] {
  const tree=readRuntimeFingerprintEvidence(sourceRoot);if(!tree)fail("runtime source lacks exact generated evidence");
  return {sourceRoot,...tree,documentSha256:sha(readAcceptedRuntimeRepairRegularFile(join(sourceRoot,"runtime-fingerprint.json")))};
}
function assertRepairReceipt(root:string,authority:DoctorRuntimeRepairAuthority):{bundleGeneration:VariantGenerationFingerprint;jsonSha256:string} {
  const bundle=join(root,"receipt","TweakersRuntimeRepairReceipt.bundle");
  verifyCandidateReceiptResourceBundle(bundle,authority.originalTrustedLeafSha1);
  if (!signatureInfo(bundle).output.includes(`Identifier=${REPAIR_RECEIPT_IDENTIFIER}\n`)) fail("signed receipt has the wrong stable identifier");
  const raw=readAcceptedRuntimeRepairRegularFile(join(bundle,"Contents","Resources","runtime-repair.json"));
  if(!isDeepStrictEqual(parseAcceptedRuntimeRepairJson(raw.toString("utf8")),authority))fail("signed receipt differs from reviewed authority");
  return {bundleGeneration:fingerprintVariantGeneration(bundle),jsonSha256:sha(raw)};
}

/** Dedicated Doctor scan: no app candidate, source download, or resolver CAS. */
export async function scanAcceptedRuntimeRepair(operationId:string):Promise<AcceptedRuntimeRepairDoctorReportV1> {
  const head=readAcceptedRuntimeRepairRecord(operationId);
  if(head) {
    // Ordinary scan reports the current review. Only the separate fixed
    // scan-successor action can prepare the single bounded continuation.
    if(head.publication.phase==="committed"||head.publication.phase==="challenge:published")authenticatedRuntimeRepairProjection(head);
    else assertPreparedRuntimeRepairAuthority(head.root,head.intent.authority);
    return readRuntimeRepairDoctorReport(head.intent.authority.review.jobId);
  }
  return prepareRuntimeRepairDoctorReview(operationId,null);
}
export async function scanAcceptedRuntimeRepairSuccessor(operationId:string,assertClosed:()=>void):Promise<AcceptedRuntimeRepairDoctorReportV1> {
  requireClosedRepairAdmission(assertClosed);
  const prior=readAcceptedRuntimeRepairRecord(operationId);if(!prior)fail("successor requires the current initial head");
  if(prior.head.version===2) {
    if(prior.publication.phase==="committed"||prior.publication.phase==="challenge:published")authenticatedRuntimeRepairProjection(prior);
    else assertPreparedRuntimeRepairAuthority(prior.root,prior.intent.authority);
    return readRuntimeRepairDoctorReport(prior.intent.authority.review.jobId);
  }
  assertSuccessorAdmission(prior);requireClosedRepairAdmission(assertClosed);
  return prepareRuntimeRepairDoctorReview(operationId,prior,assertClosed);
}
function originalCustodyFromPredecessor(prior:AcceptedRuntimeRepairRecord):AcceptedRuntimeRepairOriginalCustody {
  const authority=prior.intent.authority,journal=originalRepairJournal(prior.root,authority),managerRoot=canonicalTweakersManagerRoot();
  const retained=workerCustody(authority.originalWorker.launcherPath,authority.originalTrustedLeafSha1),custody=repairJson(prior.root,authority.originals.custody.path) as AcceptedRuntimeRepairOriginalCustodyV1;
  const origin=(value:{sourcePath:string;sourceSha256AtCapture:string})=>({path:value.sourcePath,sha256:value.sourceSha256AtCapture});
  return {managerRoot,operationId:prior.head.operationId,promotionId:prior.head.promotionId,userRoot:journal.userRoot,target:journal.target,
    trustedLeafSha1:authority.originalTrustedLeafSha1,worker:{...retained.worker,moduleRoot:retained.moduleRoot,runtimeRoot:retained.runtimeRoot},
    binding:journal.acceptedBackendTransition,files:{operation:origin(authority.originals.operation),journal:origin(authority.originals.journal),expectation:origin(authority.originals.expectation),
      recoveryBinding:authority.originals.recoveryBinding,candidateReceipt:custody.originalCandidateReceipt.json,signedReceiptBundle:custody.originalCandidateReceipt.bundlePath,
      preparedCasIntent:authority.originals.preparedCasIntent,completedCas:authority.completedCas.completed,priorRegistration:authority.completedCas.prior,registration:authority.completedCas.currentRegistration},
    generations:{app:authority.unchanged.app,runtime:authority.priorRuntime,tweaks:authority.unchanged.tweaks,state:authority.unchanged.state,config:authority.unchanged.config,priorActiveReceipt:authority.unchanged.priorActiveReceipt}};
}
async function prepareRuntimeRepairDoctorReview(operationId:string,prior:AcceptedRuntimeRepairRecord|null,assertClosed?:()=>void):Promise<AcceptedRuntimeRepairDoctorReportV1> {
  const original=prior?originalCustodyFromPredecessor(prior):readAcceptedRuntimeRepairOriginalCustody(operationId),managerRoot=original.managerRoot;
  const index=join(managerRoot,"doctor","runtime-repair",`${operationId}${prior?".successor":""}.json`);
  if(existsSync(index)) {
    const existing=parseAcceptedRuntimeRepairJson(readAcceptedRuntimeRepairPrivateFile(managerRoot,index).toString("utf8")) as {version?:number;kind?:string;operationId?:string;jobId?:string;repairId?:string};
    if(existing.version!==1||existing.kind!=="tweakers-doctor-runtime-repair-index"||existing.operationId!==operationId
      ||!isManagerOperationId(existing.jobId ?? "")||!isManagerOperationId(existing.repairId ?? ""))fail("prepared Doctor job index is invalid");
    const report=readRuntimeRepairDoctorReport(existing.jobId!);
    if(report.operationId!==operationId||report.repairId!==existing.repairId||report.promotionId!==original.promotionId)fail("prepared Doctor index changes original operation");
    return report;
  }
  const authorized=workerCustody(verifiedDoctorManagerLauncher(),original.trustedLeafSha1);
  assertCurrentRepairWorker(authorized);
  const originalWorker=workerCustody(original.worker.launcherPath,original.trustedLeafSha1);
  const sourceCustody=readRuntimeRepairSourceCustody(authorized.moduleRoot);
  const reviewedDelta=reviewRuntimeRepairGeneratedDelta(resolve(originalWorker.moduleRoot,"../../.."),resolve(authorized.moduleRoot,"../../.."),sourceCustody);
  if(prior) {
    requireClosedRepairAdmission(assertClosed!);assertSuccessorAdmission(prior);
    if(authorized.worker.generationId===prior.intent.authority.authorizedWorker.generationId)fail("successor requires newly reviewed repaired source");
  }
  const jobId=randomUUID(),repairId=randomUUID(),root=join(original.userRoot,"builds",original.promotionId,"runtime-repair","accepted","operations",repairId);
  privateDirectoryTree(original.userRoot,root);
  const copyOriginal=(name:string,key:"operation"|"journal"|"expectation")=>{
    if(!prior)return snapshot(root,name,original.files[key]);
    const origin=prior.intent.authority.originals[key],raw=readAcceptedRuntimeRepairPrivateFile(prior.root,origin.snapshot.path);
    if(sha(raw)!==origin.snapshot.sha256)fail("predecessor original snapshot changed");
    return {...origin,snapshot:writeImmutableRepairFile(root,join(root,name),raw)};
  };
  const originals={operation:copyOriginal("original-operation.json","operation"),journal:copyOriginal("original-journal.json","journal"),expectation:copyOriginal("original-expectation.json","expectation")};
  const predecessor=prior?{binding:{repairId:prior.head.repairId,headSha256:prior.readyBinding.headSha256,intentSha256:prior.head.intentSha256,authorityReceiptSha256:prior.intent.authorityReceipt.jsonSha256},
    publication:{path:join(prior.root,"publication.json"),sha256:sha(readAcceptedRuntimeRepairPrivateFile(prior.root,join(prior.root,"publication.json")))},
    challenge:snapshot(root,"predecessor-challenge.json",{path:join(original.userRoot,"runtime-ready-expectation.json"),sha256:sha(readAcceptedRuntimeRepairPrivateFile(managerRoot,join(original.userRoot,"runtime-ready-expectation.json")))}),
    installedRuntime:prior.intent.authority.repairedRuntime.generation}:null;
  const journal=parseAcceptedRuntimeRepairJson(readAcceptedRuntimeRepairPrivateFile(root,originals.journal.snapshot.path).toString("utf8")) as Record<string,any>;
  const priorRuntime=journal.entries.find((entry:{name:string})=>entry.name === "runtime").desired;
  const candidateJson=parseAcceptedRuntimeRepairJson(readAcceptedRuntimeRepairRegularFile(original.files.candidateReceipt.path).toString("utf8")) as {id:string};
  const originalCustody:AcceptedRuntimeRepairOriginalCustodyV1={version:1,kind:"tweakers-accepted-runtime-repair-original-custody",operationId,promotionId:original.promotionId,
    trustedLeafSha1:original.trustedLeafSha1,originalWorker:originalWorker.worker,
    originalCandidateReceipt:{bundlePath:original.files.signedReceiptBundle,bundleGeneration:fingerprintVariantGeneration(original.files.signedReceiptBundle),
      json:original.files.candidateReceipt,id:candidateJson.id,signingIdentityHash:original.trustedLeafSha1},
    unchanged:{app:original.generations.app,tweaks:original.generations.tweaks,state:original.generations.state,config:original.generations.config,priorActiveReceipt:original.generations.priorActiveReceipt},
    originalAcceptedBaseline:original.binding.lane.authority.runtime,priorRuntime};
  assertAcceptedRuntimeRepairOriginalCustodyContract(originalCustody,contractDependencies);
  const custodyRef=immutableJson(root,join(root,"original-custody.json"),originalCustody);
  const originalVerification=immutableJson(root,join(root,"original-sealed-source-verification.json"),{version:1,kind:"tweakers-runtime-repair-original-sealed-verification",
    qualification:"retained-sealed-module-and-runtime-not-historical-raw-ts",worker:originalWorker.worker,moduleRoot:originalWorker.moduleRoot,runtimeRoot:originalWorker.runtimeRoot,
    moduleGeneration:fingerprintVariantGeneration(originalWorker.moduleRoot),runtimeGeneration:fingerprintVariantGeneration(originalWorker.runtimeRoot),
    candidateReceipt:original.files.candidateReceipt,candidateReceiptBundleGeneration:originalCustody.originalCandidateReceipt.bundleGeneration});
  const repairedVerification={path:join(authorized.moduleRoot,RUNTIME_REPAIR_SOURCE_CUSTODY_FILE),sha256:sha(readAcceptedRuntimeRepairRegularFile(join(authorized.moduleRoot,RUNTIME_REPAIR_SOURCE_CUSTODY_FILE)))};
  const deltaRef=immutableJson(root,join(root,"reviewed-generated-delta.json"),reviewedDelta);
  const next=join(root,"next-runtime"),recovery=join(root,"accounts-transfer-recovery");
  const baseline=runtimeAuthority(authorized.runtimeRoot);
  if(sourceCustody.packagedRuntime.fingerprint!==baseline.fingerprint||sourceCustody.packagedRuntime.fileCount!==baseline.fileCount
    ||sourceCustody.packagedRuntime.documentSha256!==baseline.documentSha256)fail("Doctor worker's packaged and sealed runtime differ");
  prepareRuntimeRepairStaging(root,authorized.runtimeRoot);
  prepareProbedAccountsTransferRecovery(next,recovery);
  const validation=parseAcceptedRuntimeRepairJson(readAcceptedRuntimeRepairPrivateFile(root,join(recovery,"accounts-transfer-validation.v1.json")).toString("utf8"));
  assertAcceptedAccountsRecoveryRuntime(next,baseline);
  const repairedRuntime={generation:fingerprintVariantGeneration(next),evidence:runtimeAuthority(next)};
  const validationFingerprint=fingerprint({sourceCustody:repairedVerification,originalCustody:custodyRef,originalVerification,reviewedDelta:deltaRef,validation});
  const candidateFingerprint=fingerprint({repairedRuntime,recovery:fingerprintVariantGeneration(recovery),unchanged:originalCustody.unchanged});
  const adoptionFingerprint=fingerprint(originalCustody.unchanged),promotionFingerprint=authorized.worker.implementationScopes.promotion;
  const body={version:1 as const,kind:"tweakers-doctor-runtime-repair-report" as const,operationId,promotionId:original.promotionId,repairId,jobId,
    workerGenerationId:authorized.worker.generationId,originalJournalSha256:original.files.journal.sha256,
    validationFingerprint,candidateFingerprint,adoptionFingerprint,promotionFingerprint,reviewedDeltaSha256:deltaRef.sha256};
  const report:AcceptedRuntimeRepairDoctorReportV1={...body,fingerprint:fingerprint(body)};
  const authority:DoctorRuntimeRepairAuthority={...(predecessor?{version:2 as const,expectedPriorHeadSha256:predecessor.binding.headSha256,predecessor}:{version:1 as const,expectedPriorHeadSha256:null}),kind:"tweakers-doctor-accepted-runtime-repair",operationId,promotionId:original.promotionId,repairId,
    originals:{...originals,recoveryBinding:original.files.recoveryBinding,preparedCasIntent:original.files.preparedCasIntent,custody:custodyRef,
      acceptedBuildReceipt:{path:original.binding.lane.authority.acceptedBuildReceipt.path,sha256:original.binding.lane.authority.acceptedBuildReceipt.sha256}},
    completedCas:{planFingerprint:`sha256:${original.files.completedCas.sha256}`,prior:original.files.priorRegistration,completed:original.files.completedCas,
      currentRegistration:original.files.registration,resolverSha256:original.binding.lane.authority.backend.sha256},
    originalWorker:originalWorker.worker,authorizedWorker:authorized.worker,
    review:{jobId,reportFingerprint:report.fingerprint,validationFingerprint,candidateFingerprint,adoptionFingerprint,promotionFingerprint},
    originalTrustedLeafSha1:original.trustedLeafSha1,unchanged:{...originalCustody.unchanged,backendSha256:original.binding.lane.authority.backend.sha256,
      helperSha256:original.binding.lane.authority.closure.codeModeHost.sha256,backendSignature:original.binding.lane.authority.backend.signature,
      helperSignature:original.binding.lane.authority.closure.codeModeHost.signature,resources:original.binding.lane.authority.closure.resources},
    priorRuntime,originalAcceptedBaseline:original.binding.lane.authority.runtime,repairedBaseline:baseline,repairedRuntime,
    recovery:{root:recovery,generation:fingerprintVariantGeneration(recovery),markerSha256:sha(readAcceptedRuntimeRepairPrivateFile(root,join(next,"accounts-transfer-recovery.v1.json"))),
      validationSha256:sha(readAcceptedRuntimeRepairPrivateFile(root,join(recovery,"accounts-transfer-validation.v1.json")))},
    sourceDelta:{originalSourceVerification:originalVerification,repairedSourceVerification:repairedVerification,reviewedDelta:deltaRef,
      changedGeneratedFiles:reviewedDelta.changes.map(change=>({path:join(resolve(authorized.moduleRoot,"../../.."),change.relativePath),sha256:change.after.sha256}))},createdAt:new Date().toISOString()};
  assertDoctorRuntimeRepairAuthorityContract(authority,contractDependencies);
  const receipt=join(root,"receipt","TweakersRuntimeRepairReceipt.bundle"),resources=join(receipt,"Contents","Resources");
  privateDirectoryTree(root,resources);
  immutableJson(root,join(resources,"runtime-repair.json"),authority);
  writeImmutableRepairFile(root,join(receipt,"Contents","Info.plist"),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${REPAIR_RECEIPT_IDENTIFIER}</string><key>CFBundlePackageType</key><string>BNDL</string><key>CFBundleVersion</key><string>1</string></dict></plist>\n`);
  const identity=findExistingPreparedSigningIdentity();if(identity.hash.toUpperCase()!==original.trustedLeafSha1)fail("preexisting receipt signer differs from original trusted leaf");
  signCandidateReceiptResourceBundle(receipt,identity,REPAIR_RECEIPT_IDENTIFIER);
  assertRepairReceipt(root,authority);
  const jobRoot=join(managerRoot,"doctor","runtime-repair","jobs",jobId);
  privateDirectoryTree(managerRoot,jobRoot);
  immutableJson(jobRoot,join(jobRoot,"report.json"),report);
  immutableJson(jobRoot,join(jobRoot,"prepared.json"),{version:1,kind:"tweakers-doctor-runtime-repair-prepared",operationId,promotionId:original.promotionId,repairId,jobId,root,
    reportSha256:sha(readAcceptedRuntimeRepairPrivateFile(jobRoot,join(jobRoot,"report.json"))),authoritySha256:assertRepairReceipt(root,authority).jsonSha256});
  privateDirectoryTree(managerRoot,dirname(index));
  if(prior){requireClosedRepairAdmission(assertClosed!);assertSuccessorAdmission(prior);}
  immutableJson(managerRoot,index,{version:1,kind:"tweakers-doctor-runtime-repair-index",operationId,jobId,repairId});
  return report;
}

function readRuntimeRepairDoctorReport(jobId:string):AcceptedRuntimeRepairDoctorReportV1 {
  if(!isManagerOperationId(jobId))fail("invalid Doctor runtime repair job");
  const path=join(canonicalTweakersManagerRoot(),"doctor","runtime-repair","jobs",jobId,"report.json");
  const value=parseAcceptedRuntimeRepairJson(readAcceptedRuntimeRepairPrivateFile(canonicalTweakersManagerRoot(),path).toString("utf8")) as AcceptedRuntimeRepairDoctorReportV1;
  const {fingerprint:observed,...body}=value;
  if(!value||Object.keys(value).sort().join(",")!==["version","kind","operationId","promotionId","repairId","jobId","workerGenerationId","originalJournalSha256",
    "validationFingerprint","candidateFingerprint","adoptionFingerprint","promotionFingerprint","reviewedDeltaSha256","fingerprint"].sort().join(",")
    ||value.version!==1||value.kind!=="tweakers-doctor-runtime-repair-report"||value.jobId!==jobId
    ||![value.operationId,value.promotionId,value.repairId].every(isManagerOperationId)
    ||![value.workerGenerationId,value.originalJournalSha256,value.reviewedDeltaSha256].every(item=>/^[a-f0-9]{64}$/.test(item))
    ||![value.validationFingerprint,value.candidateFingerprint,value.adoptionFingerprint,value.promotionFingerprint,observed].every(item=>/^sha256:[a-f0-9]{64}$/.test(item))
    ||observed!==fingerprint(body))fail("Doctor runtime repair report changed");
  return value;
}

function repairJson(root:string,path:string):any {
  return parseAcceptedRuntimeRepairJson(readAcceptedRuntimeRepairPrivateFile(root,path).toString("utf8"));
}
function assertRef(root:string,ref:AcceptedRuntimeRepairFileRef):void {
  if(sha(readAcceptedRuntimeRepairPrivateFile(root,ref.path))!==ref.sha256)fail("immutable repair reference changed");
}
function originalRepairJournal(root:string,authority:DoctorRuntimeRepairAuthority):Record<string,any> {
  assertRef(root,authority.originals.journal.snapshot);
  const journal=repairJson(root,authority.originals.journal.snapshot.path);
  if(journal.id!==authority.promotionId||journal.phase!=="app:promoted"||journal.acceptedBackendTransition?.operationId!==authority.operationId
    ||journal.userRoot!==join(canonicalTweakersManagerRoot(),"variants","tweakers")||journal.target!=="/Applications/Tweakers.app")fail("original journal binding differs");
  assertAcceptedSharedNativeBackendTransitionShape(journal.acceptedBackendTransition.lane);
  if(journal.acceptedBackendTransition.lane.version!==1)fail("original repair requires the historical accepted-build lane");
  if(sha(readAcceptedRuntimeRepairPrivateFile(canonicalTweakersManagerRoot(),authority.originals.journal.sourcePath))!==authority.originals.journal.sourceSha256AtCapture)
    fail("original promotion journal changed");
  return journal;
}

/** Independently authenticate the signed source and original custody at every publication boundary. */
function assertPreparedRuntimeRepairAuthority(root:string,authority:DoctorRuntimeRepairAuthority,retained=false):void {
  assertDoctorRuntimeRepairAuthorityContract(authority,contractDependencies);
  const managerRoot=canonicalTweakersManagerRoot();
  if(root!==join(managerRoot,"variants","tweakers","builds",authority.promotionId,"runtime-repair","accepted","operations",authority.repairId))fail("repair authority is foreign");
  const original=workerCustody(authority.originalWorker.launcherPath,authority.originalTrustedLeafSha1);
  const retainedModule=readAcceptedRuntimeRepairRegularFile(join(original.moduleRoot,"manager-descriptor.js")).toString("utf8");
  const anchors=[...retainedModule.matchAll(/const PINNED_MANAGER_DESIGNATED_REQUIREMENT\s*=\s*'identifier "com\.therealityreport\.tweakers\.manager-launcher" and certificate leaf = H"([a-f0-9]{40})"';?/g)];
  if(anchors.length!==1||anchors[0]![1]!.toUpperCase()!==authority.originalTrustedLeafSha1||!isDeepStrictEqual(original.worker,authority.originalWorker))
    fail("original independently retained signer custody changed");
  const authorized=workerCustody(retained?authority.authorizedWorker.launcherPath:verifiedDoctorManagerLauncher(),authority.originalTrustedLeafSha1);
  if(!retained)assertCurrentRepairWorker(authorized);
  if(!isDeepStrictEqual(authorized.worker,authority.authorizedWorker))fail("current worker is not the signed delegated generation");
  assertRepairReceipt(root,authority);
  for(const origin of [authority.originals.operation,authority.originals.journal,authority.originals.expectation]) {
    if(origin.sourceSha256AtCapture!==origin.snapshot.sha256)fail("original snapshot is not exact captured bytes");
    assertRef(root,origin.snapshot);
  }
  const operation=repairJson(root,authority.originals.operation.snapshot.path);
  assertAcceptedRuntimeRepairOriginalOperationProjection(operation,new ManagerOperationStore(managerRoot).read(authority.operationId));
  if(operation.operationId!==authority.operationId||operation.moduleIdentity?.path!==authority.originalWorker.launcherPath
    ||operation.moduleIdentity.sha256!==authority.originalWorker.launcherSha256)fail("original operation lost signed worker custody");
  const journal=originalRepairJournal(root,authority),lane=journal.acceptedBackendTransition.lane;
  assertRef(root,authority.originals.custody);
  const custody:unknown=repairJson(root,authority.originals.custody.path);
  assertAcceptedRuntimeRepairOriginalCustodyContract(custody,contractDependencies);
  if(custody.operationId!==authority.operationId||custody.promotionId!==authority.promotionId
    ||custody.trustedLeafSha1!==authority.originalTrustedLeafSha1||!isDeepStrictEqual(custody.originalWorker,authority.originalWorker))fail("original custody is foreign");
  verifyCandidateReceiptResourceBundle(custody.originalCandidateReceipt.bundlePath,authority.originalTrustedLeafSha1);
  assertGeneration(custody.originalCandidateReceipt.bundlePath,custody.originalCandidateReceipt.bundleGeneration);
  if(sha(readAcceptedRuntimeRepairRegularFile(custody.originalCandidateReceipt.json.path))!==custody.originalCandidateReceipt.json.sha256)fail("original signed receipt changed");
  const candidate=parseAcceptedRuntimeRepairJson(readAcceptedRuntimeRepairRegularFile(custody.originalCandidateReceipt.json.path).toString("utf8")) as Record<string,any>;
  if(candidate.id!==custody.originalCandidateReceipt.id||candidate.signingIdentityHash!==authority.originalTrustedLeafSha1
    ||!isDeepStrictEqual(candidate.acceptedBackendTransition,lane)||!isDeepStrictEqual(candidate.artifacts.app,authority.unchanged.app))fail("original signed candidate differs");
  const baseline=runtimeAuthority(authorized.runtimeRoot),source=readRuntimeRepairSourceCustody(authorized.moduleRoot);
  if(!isDeepStrictEqual(baseline,authority.repairedBaseline)||!isDeepStrictEqual(runtimeAuthority(original.runtimeRoot),{...authority.originalAcceptedBaseline,sourceRoot:original.runtimeRoot}))
    fail("repair source baseline changed");
  if(!isDeepStrictEqual(source.packagedRuntime,{fingerprint:baseline.fingerprint,fileCount:baseline.fileCount,documentSha256:baseline.documentSha256}))fail("repair source check baseline changed");
  assertRef(root,authority.sourceDelta.reviewedDelta);
  const actualDelta=reviewRuntimeRepairGeneratedDelta(resolve(original.moduleRoot,"../../.."),resolve(authorized.moduleRoot,"../../.."),source);
  if(!isDeepStrictEqual(actualDelta,repairJson(root,authority.sourceDelta.reviewedDelta.path)))fail("reviewed generated delta changed");
  const sourceRecord=join(authorized.moduleRoot,RUNTIME_REPAIR_SOURCE_CUSTODY_FILE);
  if(authority.sourceDelta.repairedSourceVerification.path!==sourceRecord||sha(readAcceptedRuntimeRepairRegularFile(sourceRecord))!==authority.sourceDelta.repairedSourceVerification.sha256)
    fail("repaired source verification is not sealed worker custody");
  assertRef(root,authority.sourceDelta.originalSourceVerification);
  const originalVerification=repairJson(root,authority.sourceDelta.originalSourceVerification.path);
  if(originalVerification.qualification!=="retained-sealed-module-and-runtime-not-historical-raw-ts"
    ||!isDeepStrictEqual(originalVerification.worker,original.worker)||originalVerification.moduleRoot!==original.moduleRoot
    ||originalVerification.runtimeRoot!==original.runtimeRoot||!isDeepStrictEqual(originalVerification.moduleGeneration,fingerprintVariantGeneration(original.moduleRoot))
    ||!isDeepStrictEqual(originalVerification.runtimeGeneration,fingerprintVariantGeneration(original.runtimeRoot)))fail("original emitted verification changed");
  if(!isDeepStrictEqual(authority.sourceDelta.changedGeneratedFiles,actualDelta.changes.map(change=>({path:join(resolve(authorized.moduleRoot,"../../.."),change.relativePath),sha256:change.after.sha256}))))
    fail("changed generated paths exceed reviewed mapping");
  assertAcceptedSharedNativeBackendTransitionPairClosure(lane,journal.target);
  for(const [name,expected] of [["app",authority.unchanged.app],["tweaks",authority.unchanged.tweaks],["state.json",authority.unchanged.state],["config.json",authority.unchanged.config]] as const) {
    const entry=journal.entries.find((item:{name:string})=>item.name===name);
    if(!isDeepStrictEqual(entry?.desired,expected))fail("repair changed original desired generation");
    assertGeneration(entry.destination,expected);
  }
  for(const ref of [authority.originals.recoveryBinding,authority.originals.preparedCasIntent,authority.completedCas.prior,authority.completedCas.completed,authority.completedCas.currentRegistration])assertRef(managerRoot,ref);
  const cas=repairJson(managerRoot,authority.originals.preparedCasIntent.path);
  if(cas.journalPath!==authority.originals.journal.sourcePath||sha(cas.preparedJournalBytes)!==cas.preparedJournalSha256
    ||!isDeepStrictEqual(JSON.parse(cas.preparedJournalBytes),{...journal,phase:"prepared"})||cas.planFingerprint!==authority.completedCas.planFingerprint
    ||`sha256:${authority.completedCas.completed.sha256}`!==authority.completedCas.planFingerprint)fail("completed CAS plan custody changed");
  const result=sharedNativeBackendTransitionPort(original.runtimeRoot).executeSharedNativeResolverTransitionAtRootV1({stateRoot:lane.identity.brokerRoot,
    plan:cas.plan,expectedPlanFingerprint:cas.planFingerprint,action:"validate"});
  if(result.state!=="validated"||result.resolverBinarySha256!==authority.unchanged.backendSha256
    ||result.priorFingerprint!==lane.priorRegistrationFingerprint||result.priorResolverBinarySha256!==lane.priorResolverBinarySha256)fail("completed registration changed");
  if(!isDeepStrictEqual(authority.originalAcceptedBaseline,lane.authority.runtime)||authority.unchanged.backendSha256!==lane.authority.backend.sha256
    ||authority.unchanged.helperSha256!==lane.authority.closure.codeModeHost.sha256||!isDeepStrictEqual(authority.unchanged.backendSignature,lane.authority.backend.signature)
    ||!isDeepStrictEqual(authority.unchanged.helperSignature,lane.authority.closure.codeModeHost.signature)||!isDeepStrictEqual(authority.unchanged.resources,lane.authority.closure.resources))fail("repair changed executable authority");
  if(authority.version===2) {
    const previous=predecessorRecord(authority);assertPreparedRuntimeRepairAuthority(previous.root,previous.intent.authority,true);
    assertPredecessorAcceptanceAbsent(previous);
    for(const key of ["originalWorker","originalTrustedLeafSha1","unchanged","completedCas","priorRuntime","originalAcceptedBaseline"] as const)
      if(!isDeepStrictEqual(authority[key],previous.intent.authority[key]))fail("successor changed original custody");
    for(const key of ["acceptedBuildReceipt","recoveryBinding","preparedCasIntent"] as const)
      if(!isDeepStrictEqual(authority.originals[key],previous.intent.authority.originals[key]))fail("successor changed original file authority");
    if(authority.originals.custody.sha256!==previous.intent.authority.originals.custody.sha256
      ||authority.sourceDelta.originalSourceVerification.sha256!==previous.intent.authority.sourceDelta.originalSourceVerification.sha256)fail("successor changed immutable original custody bytes");
    for(const key of ["operation","journal","expectation"] as const) {
      const a=authority.originals[key],b=previous.intent.authority.originals[key];
      if(a.sourcePath!==b.sourcePath||a.sourceSha256AtCapture!==b.sourceSha256AtCapture||a.snapshot.sha256!==b.snapshot.sha256)fail("successor changed original snapshots");
    }
    if(!isDeepStrictEqual(authority.predecessor.installedRuntime,previous.intent.authority.repairedRuntime.generation)
      ||authority.predecessor.challenge.sourcePath!==join(journal.userRoot,"runtime-ready-expectation.json")
      ||authority.predecessor.challenge.snapshot.path!==join(root,"predecessor-challenge.json")
      ||authority.predecessor.challenge.sourceSha256AtCapture!==authority.predecessor.challenge.snapshot.sha256)fail("successor predecessor binding changed");
    assertRef(root,authority.predecessor.challenge.snapshot);
    const capturedChallenge=repairJson(root,authority.predecessor.challenge.snapshot.path);assertPredecessorChallenge(previous,capturedChallenge);
    if(authority.authorizedWorker.generationId===previous.intent.authority.authorizedWorker.generationId
      ||isDeepStrictEqual(authority.repairedRuntime.generation,authority.predecessor.installedRuntime)
      ||Date.parse(authority.createdAt)<Date.parse(capturedChallenge.createdAt))fail("successor lacks a newly reviewed repaired generation after predecessor challenge");
    assertGeneration(join(previous.root,"prior-runtime"),authority.priorRuntime);
    const archived=join(root,"prior-runtime");
    assertRepairedRuntime(previous,existsSync(archived)?archived:join(journal.userRoot,"runtime"));
  }
}

/** Classification reads the actual signed review; inputs cannot select its version. */
export function acceptedRuntimeRepairApprovalRequiresClosedAdmission(jobId:string,reportFingerprint:string):boolean {
  const report=readRuntimeRepairDoctorReport(jobId),managerRoot=canonicalTweakersManagerRoot(),jobRoot=join(managerRoot,"doctor","runtime-repair","jobs",jobId);
  if(report.fingerprint!==reportFingerprint)fail("Doctor runtime repair review changed");
  const prepared=repairJson(managerRoot,join(jobRoot,"prepared.json"));
  const root=join(managerRoot,"variants","tweakers","builds",report.promotionId,"runtime-repair","accepted","operations",report.repairId);
  const authority=repairJson(root,join(root,"receipt","TweakersRuntimeRepairReceipt.bundle","Contents","Resources","runtime-repair.json"));
  assertDoctorRuntimeRepairAuthorityContract(authority,contractDependencies);
  if(prepared.root!==root||prepared.jobId!==jobId||prepared.operationId!==report.operationId||prepared.repairId!==report.repairId
    ||prepared.reportSha256!==sha(readAcceptedRuntimeRepairPrivateFile(managerRoot,join(jobRoot,"report.json")))
    ||authority.review.reportFingerprint!==reportFingerprint||authority.review.jobId!==jobId||prepared.authoritySha256!==assertRepairReceipt(root,authority).jsonSha256)
    fail("Doctor approval differs from signed review");
  return authority.version===2;
}
export function approveAcceptedRuntimeRepair(jobId:string,reportFingerprint:string,assertClosed?:()=>void):AcceptedRuntimeRepairConsumedApprovalV1 {
  const report=readRuntimeRepairDoctorReport(jobId),managerRoot=canonicalTweakersManagerRoot(),jobRoot=join(managerRoot,"doctor","runtime-repair","jobs",jobId);
  if(report.fingerprint!==reportFingerprint)fail("Doctor runtime repair review changed");
  const prepared=repairJson(managerRoot,join(jobRoot,"prepared.json"));
  const root=join(managerRoot,"variants","tweakers","builds",report.promotionId,"runtime-repair","accepted","operations",report.repairId);
  if(prepared.root!==root||prepared.jobId!==jobId||prepared.operationId!==report.operationId||prepared.repairId!==report.repairId
    ||prepared.reportSha256!==sha(readAcceptedRuntimeRepairPrivateFile(managerRoot,join(jobRoot,"report.json"))))fail("prepared Doctor binding differs");
  const authority=repairJson(root,join(root,"receipt","TweakersRuntimeRepairReceipt.bundle","Contents","Resources","runtime-repair.json"));
  assertDoctorRuntimeRepairAuthorityContract(authority,contractDependencies);
  if(authority.review.reportFingerprint!==reportFingerprint||authority.review.jobId!==jobId||prepared.authoritySha256!==assertRepairReceipt(root,authority).jsonSha256)
    fail("Doctor approval differs from signed review");
  if(authority.version===2)requireClosedRepairAdmission(assertClosed!);
  const existing=readAcceptedRuntimeRepairRecord(report.operationId);
  if(existing && existing.head.repairId===report.repairId) {
    if(existing.head.repairId!==report.repairId||!isDeepStrictEqual(existing.intent.authority,authority))fail("a different sole child already exists");
    if(existing.publication.phase==="committed"||existing.publication.phase==="challenge:published")authenticatedRuntimeRepairProjection(existing);
    else assertPreparedRuntimeRepairAuthority(root,authority);
    return repairJson(root,existing.intent.consumedApproval.path);
  }
  if(authority.version===2) {
    if(!existing||existing.readyBinding.headSha256!==authority.expectedPriorHeadSha256)fail("successor approval current head changed");
    assertSuccessorAdmission(existing);
  }else if(existing)fail("a different initial child already exists");
  assertPreparedRuntimeRepairAuthority(root,authority);
  const approvedAt=new Date().toISOString();
  const approval:AcceptedRuntimeRepairConsumedApprovalV1={version:1,kind:"tweakers-doctor-runtime-repair-approval",operationId:report.operationId,repairId:report.repairId,
    jobId,reportFingerprint,authoritySha256:prepared.authoritySha256,workerGenerationId:authority.authorizedWorker.generationId,
    promotionFingerprint:authority.review.promotionFingerprint,approvedAt,expiresAt:new Date(Date.parse(approvedAt)+5*60_000).toISOString()};
  assertAcceptedRuntimeRepairConsumedApprovalContract(approval);
  const approvalPath=join(jobRoot,"approval.json"),intentPath=join(root,"intent.json"),consumedPath=join(root,"consumed-doctor-approval.json");
  if(existsSync(approvalPath)) {
    const raw=readAcceptedRuntimeRepairPrivateFile(jobRoot,approvalPath),prior=parseAcceptedRuntimeRepairJson(raw.toString("utf8"));
    assertAcceptedRuntimeRepairConsumedApprovalContract(prior);
    const consumed=existsSync(intentPath)||existsSync(consumedPath);
    const disposition=acceptedRuntimeRepairApprovalDisposition(prior,approval,Date.parse(approvedAt),consumed);
    if(consumed) {
      if(!existsSync(intentPath))fail("partial consumed approval lacks an immutable timed intent; retain evidence");
      const intent=repairJson(root,intentPath);assertAcceptedRuntimeRepairIntentContract(intent,contractDependencies);
      const expectedConsumed={path:consumedPath,sha256:sha(`${JSON.stringify(prior)}\n`)};
      if(!isDeepStrictEqual(intent.authority,authority)||!isDeepStrictEqual(intent.consumedApproval,expectedConsumed)
        ||Date.parse(intent.createdAt)<Date.parse(prior.approvedAt)||Date.parse(intent.createdAt)>Date.parse(prior.expiresAt))fail("consumed approval intent differs");
      if(existsSync(consumedPath))assertRef(root,expectedConsumed);
    }
    if(disposition==="current")return prior;
    if(authority.version===2)requireClosedRepairAdmission(assertClosed!);
    writeOrMatchImmutableRepairBytes(jobRoot,join(jobRoot,`approval.${sha(raw)}.json`),raw);
    const currentHead=readAcceptedRuntimeRepairRecord(report.operationId);
    if((authority.version===1?currentHead!==null:currentHead?.readyBinding.headSha256!==authority.expectedPriorHeadSha256)||existsSync(intentPath)||existsSync(consumedPath))fail("approval became consumed before renewal");
    if(authority.version===2)requireClosedRepairAdmission(assertClosed!);
    publishRepairJson(jobRoot,approvalPath,prior,approval);
  }else {
    if(existsSync(intentPath)||existsSync(consumedPath))fail("consumption exists without its original approval");
    if(authority.version===2)requireClosedRepairAdmission(assertClosed!);
    immutableJson(jobRoot,approvalPath,approval);
  }
  return approval;
}

/** Only expiry can renew an unused review; foreign/drifted authority is held. */
export function acceptedRuntimeRepairApprovalDisposition(existing:unknown,expected:AcceptedRuntimeRepairConsumedApprovalV1,now:number,consumed:boolean):"current"|"renew" {
  assertAcceptedRuntimeRepairConsumedApprovalContract(existing);assertAcceptedRuntimeRepairConsumedApprovalContract(expected);
  const {approvedAt,expiresAt,...binding}=existing,{approvedAt:_approvedAt,expiresAt:_expiresAt,...wanted}=expected;
  if(!isDeepStrictEqual(binding,wanted)||!Number.isFinite(now)||Date.parse(approvedAt)>now)fail("approval is foreign or drifted");
  return consumed||now<=Date.parse(expiresAt)?"current":"renew";
}

export type AcceptedRuntimeRepairAction =
  | {kind:"tweakers-accepted-runtime-repair-action";version:1;action:"scan";operationId:string}
  | {kind:"tweakers-accepted-runtime-repair-action";version:1;action:"scan-successor";operationId:string}
  | {kind:"tweakers-accepted-runtime-repair-action";version:1;action:"recover";operationId:string}
  | {kind:"tweakers-accepted-runtime-repair-action";version:1;action:"prepare-native-replacement";operationId:string}
  | {kind:"tweakers-accepted-runtime-repair-action";version:1;action:"approve";jobId:string;reportFingerprint:string};
/** The native launcher already carries this fixed <=64KiB Doctor envelope. */
export function parseAcceptedRuntimeRepairAction(value:unknown):AcceptedRuntimeRepairAction {
  if(!value||typeof value!=="object"||Array.isArray(value))fail("invalid fixed repair action");
  const item=value as Record<string,unknown>,keys=item.action==="approve"?["kind","version","action","jobId","reportFingerprint"]:["kind","version","action","operationId"];
  if(Object.keys(item).sort().join(",")!==keys.sort().join(",")||item.kind!=="tweakers-accepted-runtime-repair-action"||item.version!==1
    ||(item.action!=="scan"&&item.action!=="scan-successor"&&item.action!=="recover"&&item.action!=="prepare-native-replacement"&&item.action!=="approve"))fail("invalid fixed repair action");
  if(item.action==="approve") {
    if(typeof item.jobId!=="string"||!isManagerOperationId(item.jobId)||typeof item.reportFingerprint!=="string"||!/^sha256:[a-f0-9]{64}$/.test(item.reportFingerprint))fail("invalid fixed repair approval");
  }else if(typeof item.operationId!=="string"||!isManagerOperationId(item.operationId))fail("invalid fixed original operation");
  return item as AcceptedRuntimeRepairAction;
}

/** Operator wrappers resolve the maintained verified native launcher; no worker/root flag exists. */
export function dispatchAcceptedRuntimeRepairOperatorAction(value:unknown):unknown {
  const request=parseAcceptedRuntimeRepairAction(value),input=JSON.stringify(request);
  if(Buffer.byteLength(input)>64*1024)fail("repair envelope exceeds fixed Doctor transport");
  const launcher=verifiedDoctorManagerLauncher();
  const result=spawnSync(launcher,["doctor-action","--request-id",randomUUID(),"--json"],{input,encoding:"utf8",env:{},
    timeout:15*60_000,maxBuffer:1024*1024,stdio:["pipe","pipe","pipe"]});
  if(result.error||result.signal||result.status!==0)fail(`sealed Doctor repair action failed: ${result.error?.message??result.stderr.trim()??result.status}`);
  return parseAcceptedRuntimeRepairJson(result.stdout.trim());
}

function ensureImmutableJson(root:string,path:string,value:unknown):AcceptedRuntimeRepairFileRef {
  try {
    const raw=readAcceptedRuntimeRepairPrivateFile(root,path);
    if(!isDeepStrictEqual(parseAcceptedRuntimeRepairJson(raw.toString("utf8")),value))fail("existing immutable publication differs");
    return{path,sha256:sha(raw)};
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return immutableJson(root,path,value);}
}

/** Synchronous held-admission callback is mandatory and grants no alternate authority. */
function requireClosedRepairAdmission(assertClosed:()=>void):void {
  if(typeof assertClosed!=="function"||assertClosed()!==undefined)fail("repair requires synchronous closed desktop and broker admission");
}

/** Replay observes exactly one side of a journaled rename. Hash/signature and
 * held admission checks remain mandatory at the actual filesystem boundary. */
export function acceptedRuntimeRepairRenameDisposition(phase:AcceptedRuntimeRepairPublicationV1["phase"],sourcePresent:boolean,destinationPresent:boolean):"rename"|"published" {
  if(!["runtime:archive-planned","runtime:promote-planned","active:archive-planned","active:promote-planned"].includes(phase))
    fail("rename replay is not at an explicit planned boundary");
  if(sourcePresent===destinationPresent)fail("rename replay requires exactly one retained generation");
  return sourcePresent?"rename":"published";
}

function publishRepairJson(root:string,path:string,expected:unknown,value:unknown):void {
  assertAcceptedRuntimeRepairPrivatePath(root,dirname(path),true);
  const before=readAcceptedRuntimeRepairPrivateFile(root,path),named=lstatSync(path),parent=lstatSync(dirname(path));
  if(!isDeepStrictEqual(parseAcceptedRuntimeRepairJson(before.toString("utf8")),expected))fail("publication expected prior identity changed");
  const temporary=join(dirname(path),`.repair-publication-${randomUUID()}`);
  writeImmutableRepairFile(root,temporary,`${JSON.stringify(value)}\n`);
  const now=lstatSync(path),currentParent=lstatSync(dirname(path));
  if(named.dev!==now.dev||named.ino!==now.ino||sha(readAcceptedRuntimeRepairPrivateFile(root,path))!==sha(before)
    ||parent.dev!==currentParent.dev||parent.ino!==currentParent.ino)fail("publication ancestry or prior bytes changed; preserve temporary evidence");
  withinPinnedRepairDirectory(root,dirname(path),(assertCurrent,fd)=>{
    const retained=fstatSync(fd);
    if(retained.dev!==parent.dev||retained.ino!==parent.ino)fail("publication original parent changed before rename");
    const original=lstatSync(basename(path));
    if(original.dev!==named.dev||original.ino!==named.ino)fail("publication prior leaf changed before rename");
    assertCurrent();renameSync(basename(temporary),basename(path));fsyncSync(fd);
  });
  if(!isDeepStrictEqual(repairJson(root,path),value))fail("publication differs after rename");
}

function advanceRepairPublication(record:AcceptedRuntimeRepairRecord,phase:AcceptedRuntimeRepairPublicationV1["phase"],assertAdmission:()=>void):AcceptedRuntimeRepairRecord {
  requireClosedRepairAdmission(assertAdmission);
  assertPreparedRuntimeRepairAuthority(record.root,record.intent.authority);
  const latest=readAcceptedRuntimeRepairRecord(record.head.operationId);
  if(!latest||!isDeepStrictEqual(latest,record))fail("repair head changed before publication");
  const value={...record.publication,phase};
  publishRepairJson(record.root,join(record.root,"publication.json"),record.publication,value);
  return readAcceptedRuntimeRepairRecord(record.head.operationId)!;
}

/** Read the clock at the first intent publication boundary, after preparation.
 * An existing immutable intent never enters this fresh-consumption route. */
export function acceptedRuntimeRepairIntentPublicationTime(approval:AcceptedRuntimeRepairConsumedApprovalV1,clock:()=>number=Date.now):string {
  const now=clock(),approved=Date.parse(approval.approvedAt),expires=Date.parse(approval.expiresAt);
  if(!Number.isFinite(now)||!Number.isFinite(approved)||!Number.isFinite(expires)||now<approved||now>expires)fail("Doctor runtime repair approval expired before intent publication");
  return new Date(now).toISOString();
}

function issueApprovedRuntimeRepair(operationId:string,assertClosed:()=>void):AcceptedRuntimeRepairRecord {
  requireClosedRepairAdmission(assertClosed);
  const existing=readAcceptedRuntimeRepairRecord(operationId),managerRoot=canonicalTweakersManagerRoot();
  const successorIndex=join(managerRoot,"doctor","runtime-repair",`${operationId}.successor.json`);
  if(existing&&(existing.head.version===2||!existsSync(successorIndex)))return existing;
  if(existing)assertSuccessorAdmission(existing);
  const index=repairJson(managerRoot,existing?successorIndex:join(managerRoot,"doctor","runtime-repair",`${operationId}.json`));
  if(index.version!==1||index.kind!=="tweakers-doctor-runtime-repair-index"||index.operationId!==operationId||!isManagerOperationId(index.jobId)||!isManagerOperationId(index.repairId))fail("no canonical reviewed repair index");
  const report=readRuntimeRepairDoctorReport(index.jobId),jobRoot=join(managerRoot,"doctor","runtime-repair","jobs",index.jobId);
  const prepared=repairJson(managerRoot,join(jobRoot,"prepared.json"));
  const root=join(managerRoot,"variants","tweakers","builds",report.promotionId,"runtime-repair","accepted","operations",report.repairId);
  if(prepared.root!==root||report.repairId!==index.repairId||report.operationId!==operationId)fail("reviewed repair index is foreign");
  const authority=repairJson(root,join(root,"receipt","TweakersRuntimeRepairReceipt.bundle","Contents","Resources","runtime-repair.json"));
  assertDoctorRuntimeRepairAuthorityContract(authority,contractDependencies);
  if(authority.version===2?existing?.readyBinding.headSha256!==authority.expectedPriorHeadSha256:existing!==null)fail("reviewed authority expected head changed");
  assertPreparedRuntimeRepairAuthority(root,authority);
  const signed=assertRepairReceipt(root,authority),approval=repairJson(managerRoot,join(jobRoot,"approval.json"));
  assertAcceptedRuntimeRepairConsumedApprovalContract(approval);
  if(approval.operationId!==operationId||approval.repairId!==report.repairId||approval.jobId!==report.jobId||approval.reportFingerprint!==report.fingerprint
    ||approval.authoritySha256!==signed.jsonSha256||approval.workerGenerationId!==authority.authorizedWorker.generationId
    ||approval.promotionFingerprint!==authority.review.promotionFingerprint||prepared.authoritySha256!==signed.jsonSha256)fail("approved repair differs from signed reviewed generation");
  const intentPath=join(root,"intent.json");
  if(!existsSync(intentPath)&&(Date.now()<Date.parse(approval.approvedAt)||Date.now()>Date.parse(approval.expiresAt)))
    fail("Doctor runtime repair approval expired before consumption");
  const journal=originalRepairJournal(root,authority),active=createAcceptedRuntimeRepairEffectiveActiveReceipt(journal as {activeReceipt:{expected:Record<string,any>}},authority.repairId,signed.jsonSha256,authority.repairedRuntime.generation);
  const effectiveActiveReceipt=ensureImmutableJson(root,join(root,"effective-active-receipt.json"),active),activeGeneration=fingerprintVariantGeneration(effectiveActiveReceipt.path);
  const effectiveJournal=ensureImmutableJson(root,join(root,"effective-journal.json"),createAcceptedRuntimeRepairEffectiveJournal(journal,root,authority.repairedRuntime.generation,active,activeGeneration));
  const approvalBytes=Buffer.from(`${JSON.stringify(approval)}\n`),consumedApproval={path:join(root,"consumed-doctor-approval.json"),sha256:sha(approvalBytes)};
  let intent:AcceptedRuntimeRepairIntent;
  if(existsSync(join(root,"intent.json"))) {
    intent=repairJson(root,join(root,"intent.json"));assertAcceptedRuntimeRepairIntentContract(intent,contractDependencies);
    if(!isDeepStrictEqual(intent.authority,authority)||!isDeepStrictEqual(intent.consumedApproval,consumedApproval)||!isDeepStrictEqual(intent.authorityReceipt,signed)
      ||!isDeepStrictEqual(intent.effectiveJournal,effectiveJournal)||!isDeepStrictEqual(intent.effectiveActiveReceipt,effectiveActiveReceipt))fail("unpublished immutable intent differs");
  }else {
    const createdAt=acceptedRuntimeRepairIntentPublicationTime(approval);
    intent=authority.version===2
      ?{version:2,kind:"tweakers-accepted-runtime-repair-intent",operationId,promotionId:authority.promotionId,repairId:authority.repairId,prior:authority.predecessor.binding,
        authority,authorityReceipt:signed,consumedApproval,effectiveJournal,effectiveActiveReceipt,createdAt}
      :{version:1,kind:"tweakers-accepted-runtime-repair-intent",operationId,promotionId:authority.promotionId,repairId:authority.repairId,prior:null,
        authority,authorityReceipt:signed,consumedApproval,effectiveJournal,effectiveActiveReceipt,createdAt};
    assertAcceptedRuntimeRepairIntentContract(intent,contractDependencies);ensureImmutableJson(root,join(root,"intent.json"),intent);
  }
  if(Date.parse(intent.createdAt)<Date.parse(approval.approvedAt)||Date.parse(intent.createdAt)>Date.parse(approval.expiresAt))fail("immutable intent lacks timely approval consumption");
  // Publish the real timed intent first. A crash before the approval snapshot
  // can then replay its exact bytes without inventing a later consumption time.
  writeOrMatchImmutableRepairBytes(root,consumedApproval.path,approvalBytes);
  const intentSha256=sha(readAcceptedRuntimeRepairPrivateFile(root,join(root,"intent.json")));
  const head:AcceptedRuntimeRepairHead=intent.version===2
    ?{version:2,kind:"tweakers-accepted-runtime-repair-head",operationId,promotionId:authority.promotionId,repairId:authority.repairId,intentSha256,prior:intent.prior}
    :{version:1,kind:"tweakers-accepted-runtime-repair-head",operationId,promotionId:authority.promotionId,repairId:authority.repairId,intentSha256,prior:null};
  ensureImmutableJson(root,join(root,"head.json"),head);
  ensureImmutableJson(root,join(root,"publication.json"),{version:1,kind:"tweakers-accepted-runtime-repair-publication",operationId,promotionId:authority.promotionId,repairId:authority.repairId,intentSha256,phase:"prepared"});
  requireClosedRepairAdmission(assertClosed);assertPreparedRuntimeRepairAuthority(root,authority);
  // Initial O_EXCL or the single exact-prior head CAS; prior immutable child
  // bytes remain retained. No accepted child or V2 head can be replaced.
  if(authority.version===2) {
    if(!existing)fail("successor lost its predecessor");
    requireClosedRepairAdmission(assertClosed);assertSuccessorAdmission(existing);
    if(sha(readAcceptedRuntimeRepairPrivateFile(managerRoot,acceptedRuntimeRepairHeadPath(operationId)))!==authority.expectedPriorHeadSha256)fail("head CAS expected raw bytes changed");
    publishRepairJson(managerRoot,acceptedRuntimeRepairHeadPath(operationId),existing.head,head);
  }else immutableJson(managerRoot,acceptedRuntimeRepairHeadPath(operationId),head);
  return readAcceptedRuntimeRepairRecord(operationId)!;
}

function definitelyAbsent(path:string):boolean {
  try{lstatSync(path);return false;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return true;throw error;}
}
function assertRepairedRuntime(record:AcceptedRuntimeRepairRecord,path:string):void {
  const authority=record.intent.authority;
  assertGeneration(path,authority.repairedRuntime.generation);
  const observed=assertAcceptedAccountsRecoveryRuntime(path,authority.repairedBaseline);
  if(observed.fingerprint!==authority.repairedRuntime.evidence.fingerprint||observed.fileCount!==authority.repairedRuntime.evidence.fileCount
    ||sha(readAcceptedRuntimeRepairRegularFile(join(path,"runtime-fingerprint.json")))!==authority.repairedRuntime.evidence.documentSha256)
    fail("repaired full runtime identity changed");
  assertGeneration(authority.recovery.root,authority.recovery.generation);
  if(sha(readAcceptedRuntimeRepairPrivateFile(path,join(path,"accounts-transfer-recovery.v1.json")))!==authority.recovery.markerSha256
    ||sha(readAcceptedRuntimeRepairPrivateFile(authority.recovery.root,join(authority.recovery.root,"accounts-transfer-validation.v1.json")))!==authority.recovery.validationSha256)
    fail("signed Accounts recovery metadata changed");
}

function guardedRepairRename(record:AcceptedRuntimeRepairRecord,source:string,destination:string,expected:VariantGenerationFingerprint,assertAdmission:()=>void):void {
  requireClosedRepairAdmission(assertAdmission);assertPreparedRuntimeRepairAuthority(record.root,record.intent.authority);
  if(!definitelyAbsent(destination))fail("repair destination is already occupied");
  assertGeneration(source,expected);
  const sourceParent=lstatSync(dirname(source)),destinationParent=lstatSync(dirname(destination));
  assertAcceptedRuntimeRepairPrivatePath(canonicalTweakersManagerRoot(),dirname(source),true);
  assertAcceptedRuntimeRepairPrivatePath(canonicalTweakersManagerRoot(),dirname(destination),true);
  requireClosedRepairAdmission(assertAdmission);
  const sourceNow=lstatSync(dirname(source)),destinationNow=lstatSync(dirname(destination));
  if(sourceParent.dev!==sourceNow.dev||sourceParent.ino!==sourceNow.ino||destinationParent.dev!==destinationNow.dev||destinationParent.ino!==destinationNow.ino)
    fail("repair rename ancestry changed");
  renameSync(source,destination);syncDirectory(dirname(source));syncDirectory(dirname(destination));
  if(!definitelyAbsent(source))fail("repair source survived publication unexpectedly");
  assertGeneration(destination,expected);
}

interface RuntimeRepairBootstrapPort {
  readAcceptedRuntimeRepairBootstrap(input:{managerRoot:string;userRoot:string;target:string;operationId:string;promotionId:string},
    deps:{fingerprint:typeof fingerprintVariantGeneration}):{phase:"challenge:published"|"committed";runtimeRepair:AcceptedRuntimeRepairReadyBindingV1;effectiveJournal:unknown;effectiveActiveReceipt:unknown}|null;
}
/** Execute only the independently verified delegated worker's fixed adapter, never candidate main.js. */
function authenticatedRuntimeRepairProjection(record:AcceptedRuntimeRepairRecord) {
  const authorized=workerCustody(verifiedDoctorManagerLauncher(),record.intent.authority.originalTrustedLeafSha1);
  if(!isDeepStrictEqual(authorized.worker,record.intent.authority.authorizedWorker))fail("current sealed worker is not delegated");
  const managedRoot=resolve(authorized.moduleRoot,"../../.."),path=join(managedRoot,"packages","installer","assets","runtime","accepted-runtime-repair-bootstrap.js");
  const loaded=createRequire(import.meta.url)(path) as RuntimeRepairBootstrapPort;
  if(typeof loaded.readAcceptedRuntimeRepairBootstrap!=="function")fail("delegated worker lacks the fixed runtime gate");
  const managerRoot=canonicalTweakersManagerRoot(),userRoot=join(managerRoot,"variants","tweakers"),journal=originalRepairJournal(record.root,record.intent.authority);
  const projection=loaded.readAcceptedRuntimeRepairBootstrap({managerRoot,userRoot,target:journal.target,operationId:record.head.operationId,promotionId:record.head.promotionId},
    {fingerprint:fingerprintVariantGeneration});
  if(!projection||projection.phase!==record.publication.phase||!isDeepStrictEqual(projection.runtimeRepair,record.readyBinding))fail("authenticated repair projection differs");
  return projection;
}

/** Runtime replacement is forward-only and uses the exact current child's immutable authority. */
export function resumeAcceptedRuntimeRepair(operationId:string,deps:{assertClosedAdmission:()=>void;assertAcceptedProcess:(pid:number,startToken:string)=>void}):DeferredTweakersVariantRefresh {
  if(typeof deps?.assertClosedAdmission!=="function"||typeof deps?.assertAcceptedProcess!=="function")fail("repair requires maintained closed and accepted-process guards");
  requireClosedRepairAdmission(deps.assertClosedAdmission);
  let record=issueApprovedRuntimeRepair(operationId,deps.assertClosedAdmission);
  const authority=record.intent.authority,managerRoot=canonicalTweakersManagerRoot(),userRoot=join(managerRoot,"variants","tweakers"),target="/Applications/Tweakers.app";
  const runtime=join(userRoot,"runtime"),prior=join(record.root,"prior-runtime"),next=join(record.root,"next-runtime");
  const archiveInput=authority.version===2?authority.predecessor.installedRuntime:authority.priorRuntime;
  assertPreparedRuntimeRepairAuthority(record.root,authority);
  if(record.publication.phase==="committed")fail("committed repair permits idempotent settlement only");
  if(record.publication.phase==="prepared") {
    assertGeneration(runtime,archiveInput);assertRepairedRuntime(record,next);
    if(!definitelyAbsent(prior))fail("prepared repair already has an archive");
    record=advanceRepairPublication(record,"runtime:archive-planned",deps.assertClosedAdmission);
  }
  if(record.publication.phase==="runtime:archive-planned") {
    if(acceptedRuntimeRepairRenameDisposition(record.publication.phase,!definitelyAbsent(runtime),!definitelyAbsent(prior))==="rename")guardedRepairRename(record,runtime,prior,archiveInput,deps.assertClosedAdmission);
    else assertGeneration(prior,archiveInput);
    record=advanceRepairPublication(record,"runtime:archived",deps.assertClosedAdmission);
  }
  if(record.publication.phase==="runtime:archived") {
    assertGeneration(prior,archiveInput);if(!definitelyAbsent(runtime))fail("runtime archive gap is occupied");
    assertRepairedRuntime(record,next);record=advanceRepairPublication(record,"runtime:promote-planned",deps.assertClosedAdmission);
  }
  if(record.publication.phase==="runtime:promote-planned") {
    if(acceptedRuntimeRepairRenameDisposition(record.publication.phase,!definitelyAbsent(next),!definitelyAbsent(runtime))==="rename") {assertRepairedRuntime(record,next);guardedRepairRename(record,next,runtime,authority.repairedRuntime.generation,deps.assertClosedAdmission);}
    else assertRepairedRuntime(record,runtime);
    record=advanceRepairPublication(record,"runtime:promoted",deps.assertClosedAdmission);
  }
  if(record.publication.phase==="runtime:promoted") {
    assertRepairedRuntime(record,runtime);assertGeneration(prior,archiveInput);
    const original=repairJson(record.root,authority.originals.expectation.snapshot.path);
    assertIndependentTweakersRuntimeReadyExpectation(original);
    const path=join(userRoot,"runtime-ready-expectation.json"),current=repairJson(managerRoot,path);
    const expectation={...original,schemaVersion:6 as const,runtimeRepair:record.readyBinding,runtimeFingerprint:authority.repairedRuntime.evidence.fingerprint,
      activePromotionReceiptSha256:fingerprintVariantGeneration(record.intent.effectiveActiveReceipt.path).sha256,createdAt:new Date().toISOString()};
    requireClosedRepairAdmission(deps.assertClosedAdmission);assertPreparedRuntimeRepairAuthority(record.root,authority);
    if(current.schemaVersion===6) {
      if(isDeepStrictEqual(current,{...expectation,createdAt:current.createdAt})&&Date.parse(current.createdAt)>=Date.parse(record.intent.createdAt)) {
        // Exact successor challenge already published before a crash.
      }else if(authority.version===2) {
        const captured=authority.predecessor.challenge.snapshot;
        if(!readAcceptedRuntimeRepairPrivateFile(managerRoot,path).equals(readAcceptedRuntimeRepairPrivateFile(record.root,captured.path)))fail("predecessor live challenge changed before replacement");
        assertPredecessorChallenge(predecessorRecord(authority),current);
        publishRepairJson(managerRoot,path,current,expectation);
      }else fail("published child challenge changed");
    }else {
      if(!isDeepStrictEqual(current,original))fail("original live expectation changed before child challenge");
      publishRepairJson(managerRoot,path,current,expectation);
    }
    record=advanceRepairPublication(record,"challenge:published",deps.assertClosedAdmission);
  }
  if(record.publication.phase!=="challenge:published")fail("post-canary replay requires retained acceptance and closed publication recovery");
  assertRepairedRuntime(record,runtime);
  // Only the challenge phase can launch a fresh process. Durable acceptance
  // and active publication gaps use the distinct closed replay entrypoint.
  const expectation=repairJson(managerRoot,join(userRoot,"runtime-ready-expectation.json"));assertIndependentTweakersRuntimeReadyExpectation(expectation);
  if(expectation.schemaVersion!==6||!isDeepStrictEqual(expectation.runtimeRepair,record.readyBinding)||expectation.runtimeFingerprint!==authority.repairedRuntime.evidence.fingerprint
    ||expectation.activePromotionReceiptSha256!==fingerprintVariantGeneration(record.intent.effectiveActiveReceipt.path).sha256)fail("repair replay challenge differs");
  if(record.publication.phase==="challenge:published")authenticatedRuntimeRepairProjection(record);
  let accepted:{receipt:unknown;pid:number;token:string}|null=null,retained=false;
  return{target,userRoot,recoveryMode:"forward-only",runtimeReadyExpectation:expectation,
    verifyRuntimeReady(value,pid,token) {
      if(retained)fail("repair is retained or settled");
      if(deps.assertAcceptedProcess(pid,token)!==undefined)fail("accepted process guard must be synchronous");
      verifyIndependentTweakersRuntimeReadyReceipt(expectation,value,pid,token);
      const live=readAcceptedRuntimeRepairRecord(operationId);if(!live||!isDeepStrictEqual(live.readyBinding,record.readyBinding))fail("readiness repair head changed");
      assertPreparedRuntimeRepairAuthority(record.root,authority);assertRepairedRuntime(record,runtime);
      if(!isDeepStrictEqual(repairJson(managerRoot,join(userRoot,"runtime-ready-expectation.json")),expectation))fail("repair challenge changed before acceptance");
      accepted={receipt:value,pid,token};
    },
    commit(){if(retained||!accepted)fail("repair requires fresh readiness and mandatory canaries before commitment");
      commitAcceptedRuntimeRepair(record,expectation,accepted,deps.assertAcceptedProcess);retained=true;},
    rollback(){fail("accepted runtime repair has no app-only or reverse-CAS rollback");},
    retain(){retained=true;},
  };
}

function commitAcceptedRuntimeRepair(initial:AcceptedRuntimeRepairRecord,expectation:IndependentTweakersRuntimeReadyExpectation,
  accepted:{receipt:unknown;pid:number;token:string},assertProcess:(pid:number,token:string)=>void):void {
  const managerRoot=canonicalTweakersManagerRoot(),userRoot=join(managerRoot,"variants","tweakers"),root=initial.root;
  const assertAdmission=()=>{if(assertProcess(accepted.pid,accepted.token)!==undefined)fail("accepted process guard must be synchronous");};
  assertAdmission();verifyIndependentTweakersRuntimeReadyReceipt(expectation,accepted.receipt,accepted.pid,accepted.token);
  let record=readAcceptedRuntimeRepairRecord(initial.head.operationId);
  if(!record||!isDeepStrictEqual(record.readyBinding,initial.readyBinding))fail("acceptance head changed before commitment");
  assertPreparedRuntimeRepairAuthority(root,record.intent.authority);assertRepairedRuntime(record,join(userRoot,"runtime"));
  if(record.publication.phase!=="challenge:published")fail("fresh canary commitment requires the current challenge phase");
  authenticatedRuntimeRepairProjection(record);
  const proof={schemaVersion:1,kind:"tweakers-manager-runtime-acceptance",expectation,receipt:accepted.receipt,pid:accepted.pid,processStartToken:accepted.token};
  const source=join(managerRoot,"transactions","manager-recovery-bindings",`${record.head.operationId}.acceptance.${sha(canonicalManagerJson(accepted.receipt))}.json`);
  persistManagerRuntimeAcceptance(managerRoot,expectation,accepted.receipt,accepted.pid,accepted.token);
  const sourceRaw=readAcceptedRuntimeRepairPrivateFile(managerRoot,source);
  if(!isDeepStrictEqual(parseAcceptedRuntimeRepairJson(sourceRaw.toString("utf8")),proof))fail("maintained canary proof differs");
  const sourceRef={path:source,sha256:sha(sourceRaw)};
  const snapshot=writeOrMatchImmutableRepairBytes(root,join(root,"acceptance.json"),readAcceptedRuntimeRepairPrivateFile(managerRoot,source));
  ensureImmutableJson(root,join(root,"acceptance-source.json"),{version:1,kind:"tweakers-accepted-runtime-repair-acceptance-source",sourcePath:source,
    sourceSha256AtCapture:sourceRef.sha256,snapshot});
  // These snapshots follow the genuine readiness/broker/appearance/tweak-set
  // canary. Their historical proof is retained independently of runtime-ready.
  record=advanceRepairPublication(record,"acceptance:verified",assertAdmission);
  finishAcceptedRuntimeRepairActivePublication(record,assertAdmission);
}

function writeOrMatchImmutableRepairBytes(root:string,path:string,raw:Buffer):AcceptedRuntimeRepairFileRef {
  try{const existing=readAcceptedRuntimeRepairPrivateFile(root,path);if(!existing.equals(raw))fail("immutable accepted proof bytes changed");return{path,sha256:sha(existing)};}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return writeImmutableRepairFile(root,path,raw);}
}

function finishAcceptedRuntimeRepairActivePublication(initial:AcceptedRuntimeRepairRecord,assertAdmission:()=>void):void {
  let record=initial;
  const authority=record.intent.authority,journal=originalRepairJournal(record.root,authority),destination=journal.activeReceipt.destination;
  const archive=join(record.root,"prior-active-receipt.json"),source=record.intent.effectiveActiveReceipt.path;
  const desired=fingerprintVariantGeneration(source),original=authority.unchanged.priorActiveReceipt;
  if(record.publication.phase==="acceptance:verified")record=advanceRepairPublication(record,"active:archive-planned",assertAdmission);
  if(record.publication.phase==="active:archive-planned") {
    if(acceptedRuntimeRepairRenameDisposition(record.publication.phase,!definitelyAbsent(destination),!definitelyAbsent(archive))==="rename")guardedRepairRename(record,destination,archive,original,assertAdmission);else assertGeneration(archive,original);
    record=advanceRepairPublication(record,"active:archived",assertAdmission);
  }
  if(record.publication.phase==="active:archived") {
    assertGeneration(archive,original);if(!definitelyAbsent(destination))fail("active receipt archive gap is occupied");
    record=advanceRepairPublication(record,"active:promote-planned",assertAdmission);
  }
  if(record.publication.phase==="active:promote-planned") {
    const staged=join(record.root,"next-active-receipt.json");
    if(!definitelyAbsent(destination)) {
      acceptedRuntimeRepairRenameDisposition(record.publication.phase,!definitelyAbsent(staged),true);
      assertGeneration(destination,desired);
      if(!readAcceptedRuntimeRepairPrivateFile(canonicalTweakersManagerRoot(),destination).equals(readAcceptedRuntimeRepairPrivateFile(record.root,source)))fail("published active receipt differs");
    }else {
      // Keep the immutable effective source in the child. Publish a private
      // byte-identical copy through the same guarded rename boundary.
      writeOrMatchImmutableRepairBytes(record.root,staged,readAcceptedRuntimeRepairPrivateFile(record.root,source));
      acceptedRuntimeRepairRenameDisposition(record.publication.phase,true,false);
      guardedRepairRename(record,staged,destination,desired,assertAdmission);
    }
    record=advanceRepairPublication(record,"active:promoted",assertAdmission);
  }
  if(record.publication.phase!=="active:promoted")fail("unsupported active receipt replay phase");
  assertGeneration(destination,desired);assertGeneration(archive,original);
  assertRepairedRuntime(record,join(canonicalTweakersManagerRoot(),"variants","tweakers","runtime"));
  record=advanceRepairPublication(record,"committed",assertAdmission);
  authenticatedRuntimeRepairProjection(record);
}

function assertImmutableRuntimeRepairAcceptance(record:AcceptedRuntimeRepairRecord):void {
  const root=record.root,managerRoot=canonicalTweakersManagerRoot(),raw=readAcceptedRuntimeRepairPrivateFile(root,join(root,"acceptance.json"));
  const proof=parseAcceptedRuntimeRepairJson(raw.toString("utf8")) as Record<string,any>;
  if(Object.keys(proof).sort().join(",")!==["schemaVersion","kind","expectation","receipt","pid","processStartToken"].sort().join(",")
    ||proof.schemaVersion!==1||proof.kind!=="tweakers-manager-runtime-acceptance")fail("immutable child acceptance shape differs");
  const source:unknown=repairJson(root,join(root,"acceptance-source.json"));
  assertAcceptedRuntimeRepairAcceptanceSourceContract(source,contractDependencies);
  const sourcePath=join(managerRoot,"transactions","manager-recovery-bindings",`${record.head.operationId}.acceptance.${sha(canonicalManagerJson(proof.receipt))}.json`);
  if(source.sourcePath!==sourcePath||source.snapshot.path!==join(root,"acceptance.json")||source.sourceSha256AtCapture!==sha(raw)||source.snapshot.sha256!==sha(raw)
    ||!readAcceptedRuntimeRepairPrivateFile(managerRoot,sourcePath).equals(raw))fail("immutable acceptance source/snapshot bytes changed");
  const expectation=proof.expectation;assertIndependentTweakersRuntimeReadyExpectation(expectation);
  const original=repairJson(root,record.intent.authority.originals.expectation.snapshot.path);
  if(!isDeepStrictEqual(expectation,{...original,schemaVersion:6,runtimeRepair:record.readyBinding,
    runtimeFingerprint:record.intent.authority.repairedRuntime.evidence.fingerprint,
    activePromotionReceiptSha256:fingerprintVariantGeneration(record.intent.effectiveActiveReceipt.path).sha256,createdAt:expectation.createdAt})
    ||Date.parse(expectation.createdAt)<Date.parse(record.intent.createdAt))fail("accepted expectation changed original policy or repair identity");
  // This revalidates the genuine saved canary and current broker policy. It
  // does not claim its historical PID is alive during a later closed replay.
  verifyIndependentTweakersRuntimeReadyReceipt(expectation,proof.receipt,proof.pid,proof.processStartToken);
}

/** Resume only post-canary publication, under fresh closed admission; never relaunch from a gap. */
export function finishAcceptedRuntimeRepairFromRetainedAcceptance(operationId:string,assertClosedAdmission:()=>void):void {
  requireClosedRepairAdmission(assertClosedAdmission);
  let record=readAcceptedRuntimeRepairRecord(operationId);if(!record)fail("no authoritative initial child to replay");
  if(record.publication.phase==="committed") {authenticatedRuntimeRepairProjection(record);return;}
  if(!["challenge:published","acceptance:verified","active:archive-planned","active:archived","active:promote-planned","active:promoted"].includes(record.publication.phase))
    fail("runtime replay must complete before retained canary publication");
  assertPreparedRuntimeRepairAuthority(record.root,record.intent.authority);
  assertRepairedRuntime(record,join(canonicalTweakersManagerRoot(),"variants","tweakers","runtime"));
  assertImmutableRuntimeRepairAcceptance(record);
  if(record.publication.phase==="challenge:published")record=advanceRepairPublication(record,"acceptance:verified",assertClosedAdmission);
  finishAcceptedRuntimeRepairActivePublication(record,()=>{
    requireClosedRepairAdmission(assertClosedAdmission);assertImmutableRuntimeRepairAcceptance(record!);
  });
}

export function readAuthenticatedAcceptedRuntimeRepair(operationId:string):null|ReturnType<typeof authenticatedRuntimeRepairProjection> {
  const record=readAcceptedRuntimeRepairRecord(operationId);if(!record)return null;
  if(record.publication.phase!=="committed"&&record.publication.phase!=="challenge:published")fail("unfinished child publication gap is not an active generation");
  return authenticatedRuntimeRepairProjection(record);
}

/** An immutable app:promoted journal can become retained history only after the
 * current generation passes the normal runtime gate and its sole child is
 * independently authenticated as committed and completely settled. */
export function authenticateSettledAcceptedRuntimeRepairPromotion(userRoot:string,promotionId:string,operationId:string):boolean {
  const managerRoot=canonicalTweakersManagerRoot();
  if(userRoot!==join(managerRoot,"variants","tweakers")||!isManagerOperationId(promotionId)||!isManagerOperationId(operationId))return false;
  const record=readAcceptedRuntimeRepairRecord(operationId);
  if(!record)return false;
  if(record.head.promotionId!==promotionId||record.publication.phase!=="committed"
    ||new ManagerOperationStore(managerRoot).read(operationId)?.phase!=="completed")fail("historical child is not committed and settled");
  const current=workerCustody(verifiedDoctorManagerLauncher(),record.intent.authority.originalTrustedLeafSha1);
  const runtimeRoot=join(resolve(current.moduleRoot,"../../.."),"packages","installer","assets","runtime");
  const outer=createRequire(import.meta.url)(join(runtimeRoot,"desktop-update-startup.js")) as {
    assertTweakersVariantBootstrap(options:{environment:Record<string,string>;resourcesPath:string}):unknown;
  };
  if(typeof outer.assertTweakersVariantBootstrap!=="function")fail("current worker lacks ordinary generation verification");
  // The outer gate verifies either this current child, a different fully
  // committed ordinary generation, or the complete different provisional
  // generation with its exact authenticated prior v4 receipt.
  outer.assertTweakersVariantBootstrap({environment:{TWEAKERS_DERIVED_VARIANT:"1",TWEAKERS_USER_ROOT:userRoot,TWEAKERS_RUNTIME:join(userRoot,"runtime")},
    resourcesPath:"/Applications/Tweakers.app/Contents/Resources"});
  const retained=workerCustody(record.intent.authority.authorizedWorker.launcherPath,record.intent.authority.originalTrustedLeafSha1);
  if(!isDeepStrictEqual(retained.worker,record.intent.authority.authorizedWorker))fail("historical delegated worker changed");
  const adapter=createRequire(import.meta.url)(join(resolve(retained.moduleRoot,"../../.."),"packages","installer","assets","runtime","accepted-runtime-repair-bootstrap.js")) as {
    readAcceptedRuntimeRepairHistoricalBootstrap(input:{managerRoot:string;userRoot:string;target:string;operationId:string;promotionId:string},
      deps:{fingerprint:typeof fingerprintVariantGeneration}):{phase:string;originalOperationCompleted:boolean;runtimeRepair:AcceptedRuntimeRepairReadyBindingV1}|null;
  };
  if(typeof adapter.readAcceptedRuntimeRepairHistoricalBootstrap!=="function")fail("retained worker lacks authenticated historical verification");
  const projection=adapter.readAcceptedRuntimeRepairHistoricalBootstrap({managerRoot,userRoot,target:"/Applications/Tweakers.app",operationId,promotionId},
    {fingerprint:fingerprintVariantGeneration});
  if(!projection||projection.phase!=="committed"||projection.originalOperationCompleted!==true
    ||!isDeepStrictEqual(projection.runtimeRepair,record.readyBinding))fail("historical child projection differs");
  return true;
}

/** Idempotent settlement changes only the original operation's maintained final fields. */
export function settleAcceptedRuntimeRepair(operationId:string):boolean {
  const record=readAcceptedRuntimeRepairRecord(operationId);if(!record||record.publication.phase!=="committed")return false;
  authenticatedRuntimeRepairProjection(record);
  const managerRoot=canonicalTweakersManagerRoot(),store=new ManagerOperationStore(managerRoot),current=store.read(operationId);
  const original=repairJson(record.root,record.intent.authority.originals.operation.snapshot.path);
  assertAcceptedRuntimeRepairOriginalOperationProjection(original,current);
  if(!current)fail("original operation is absent");
  if(current.phase==="completed")return true;
  const completed={...current,phase:"completed" as const,cancelledAt:null,completedAt:new Date().toISOString(),failedAt:null,recoveryRequiredAt:null,
    outcome:"verified-installation-accepted",error:null};
  assertAcceptedRuntimeRepairOriginalOperationProjection(original,completed);
  store.replace(completed);authenticatedRuntimeRepairProjection(record);
  return store.read(operationId)?.phase==="completed";
}

/** Supersession is a separate signed history event. It cannot turn the failed
 * custom-backend publication into acceptance, rewrite its journal, or grant a
 * new backend CAS. The ordinary Doctor review still owns the new installation. */
interface NativeReplacementIntentV1 {
  version:1;kind:"tweakers-native-replacement-intent";operationId:string;promotionId:string;repairId:string|null;
  replacementId:string;createdAt:string;trustedLeafSha1:string;worker:AcceptedRuntimeRepairWorkerCustodyV1;
  originalOperation:TweakersManagerPreparedOperationV1;
  retained: {path:string;generation:VariantGenerationFingerprint}[];
  unchanged: {path:string;generation:VariantGenerationFingerprint}[];
  previousApp:{path:string;destination:string;generation:VariantGenerationFingerprint;identity:{dev:number;ino:number}};
  nativeRequest:AcceptedSharedNativeBackendTransitionRequestV2|null;
}
const NATIVE_REPLACEMENT_RECEIPT_IDENTIFIER="com.thomashulihan.tweakers.native-replacement";
function nativeReplacementRoot(operationId:string):string {
  if(!isManagerOperationId(operationId))fail("invalid native replacement operation");
  return join(canonicalTweakersManagerRoot(),"transactions","native-replacements",operationId);
}
/** The consumed old operation remains failed. Preserve every other field,
 * including its original error, parameters, module identity and receipt refs. */
export function supersededNativeReplacementOperation(original:TweakersManagerPreparedOperationV1,at:string):TweakersManagerPreparedOperationV1 {
  return supersededNativeReplacementOperationProjection(original,at) as unknown as TweakersManagerPreparedOperationV1;
}
/** Both sides present/absent are uncertainty, never permission to discard. */
export function nativeReplacementRetirementDisposition(sourcePresent:boolean,destinationPresent:boolean):"move"|"retained" {
  if(sourcePresent===destinationPresent)fail("native replacement requires exactly one retained app");
  return sourcePresent?"move":"retained";
}
function pinnedReplacementLeaf():string {
  const leaf=/^identifier "com\.therealityreport\.tweakers\.manager-launcher" and certificate leaf = H"([a-f0-9]{40})"$/.exec(TWEAKERS_MANAGER_LAUNCHER_DESIGNATED_REQUIREMENT)?.[1];
  if(!leaf||leaf.toUpperCase()!==NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1)fail("native replacement lacks the maintained independent signer pin");
  return leaf.toUpperCase();
}
function replacementBundle(root:string,name:"intent"|"settlement"):string {return join(root,`${name}.bundle`);}
function replacementSignedJson(root:string,name:"intent"|"settlement"):unknown {
  const bundle=replacementBundle(root,name),leaf=pinnedReplacementLeaf();
  verifyCandidateReceiptResourceBundle(bundle,leaf);
  if(!signatureInfo(bundle).output.includes(`Identifier=${NATIVE_REPLACEMENT_RECEIPT_IDENTIFIER}.${name}\n`))fail("native replacement receipt identifier differs");
  return parseAcceptedRuntimeRepairJson(readAcceptedRuntimeRepairRegularFile(join(bundle,"Contents","Resources","receipt.json")).toString("utf8"));
}
function publishReplacementBundle(root:string,name:"intent"|"settlement",value:unknown):void {
  const bundle=replacementBundle(root,name),resources=join(bundle,"Contents","Resources"),identifier=`${NATIVE_REPLACEMENT_RECEIPT_IDENTIFIER}.${name}`;
  privateDirectoryTree(root,resources);
  ensureImmutableJson(root,join(resources,"receipt.json"),value);
  const plist=`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundlePackageType</key><string>BNDL</string><key>CFBundleVersion</key><string>1</string></dict></plist>\n`;
  const info=join(bundle,"Contents","Info.plist");
  if(existsSync(info)){if(!readAcceptedRuntimeRepairRegularFile(info).equals(Buffer.from(plist)))fail("native replacement receipt metadata differs");}
  else writeImmutableRepairFile(root,info,plist);
  const identity=findExistingPreparedSigningIdentity();
  if(identity.hash.toUpperCase()!==pinnedReplacementLeaf())fail("native replacement receipt signer differs");
  signCandidateReceiptResourceBundle(bundle,identity,identifier);
  if(!isDeepStrictEqual(replacementSignedJson(root,name),value))fail("native replacement signed bytes differ");
}
function validateNativeReplacementIntent(value:unknown,operationId:string):asserts value is NativeReplacementIntentV1 {
  if(!value||typeof value!=="object"||Array.isArray(value))fail("invalid native replacement intent");
  const v=value as NativeReplacementIntentV1,managerRoot=canonicalTweakersManagerRoot(),variant=join(managerRoot,"variants","tweakers");
  const keys=["version","kind","operationId","promotionId","repairId","replacementId","createdAt","trustedLeafSha1","worker","originalOperation","retained","unchanged","previousApp","nativeRequest"];
  if(Object.keys(v).sort().join(",")!==keys.sort().join(",")||v.version!==1||v.kind!=="tweakers-native-replacement-intent"||v.operationId!==operationId
    ||![v.promotionId,v.replacementId].every(isManagerOperationId)||(v.repairId!==null&&!isManagerOperationId(v.repairId))||v.trustedLeafSha1!==pinnedReplacementLeaf()
    ||v.originalOperation?.operationId!==operationId||!Array.isArray(v.retained)||!Array.isArray(v.unchanged)||v.retained.length<3||v.unchanged.length<5
    ||v.previousApp?.path!==join(variant,"previous",v.promotionId,"app","Tweakers.app")
    ||v.previousApp.destination!==join(targetUserHome(),".Trash",`Tweakers-superseded-${v.replacementId}`,"Tweakers.app")
    ||(v.nativeRequest===null?v.repairId!==null:v.nativeRequest?.version!==2||v.nativeRequest.officialBundled.transactionId!==v.replacementId))fail("native replacement intent changes fixed custody");
  supersededNativeReplacementOperation(v.originalOperation,v.createdAt);
  const expectedJournal=join(variant,"transactions","variant-promotion",`${v.promotionId}.json`);
  if(!v.retained.some(e=>e.path===expectedJournal)||v.retained.some(e=>!e.path.startsWith(managerRoot+"/")||e.path!==resolve(e.path))
    ||v.unchanged.some(e=>e.path!=="/Applications/Tweakers.app"&&!e.path.startsWith(managerRoot+"/")))fail("native replacement retained scope differs");
  const retained=workerCustody(v.worker.launcherPath,v.trustedLeafSha1);
  if(!isDeepStrictEqual(retained.worker,v.worker))fail("native replacement sealed worker changed");
}
function assertNativeReplacementRetained(intent:NativeReplacementIntentV1):void {
  for(const entry of intent.retained)assertGeneration(entry.path,entry.generation);
  if(intent.repairId===null) {
    const managerRoot=canonicalTweakersManagerRoot(),variant=join(managerRoot,"variants","tweakers");
    const journal:any=repairJson(managerRoot,join(variant,"transactions","variant-promotion",`${intent.promotionId}.json`));
    assertAcceptedSharedNativeBackendTransitionShape(journal.acceptedBackendTransition?.lane);
    if(journal.phase!=="app:promoted"||journal.acceptedBackendTransition.operationId!==intent.operationId
      ||journal.acceptedBackendTransition.lane.version!==2)fail("native replacement retained native journal changed");
    assertNativeReplacementAcceptanceAbsent(managerRoot,intent.operationId);
    return;
  }
  const record=readAcceptedRuntimeRepairRecord(intent.operationId);
  if(!record||record.head.repairId!==intent.repairId||record.head.promotionId!==intent.promotionId||record.publication.phase!=="challenge:published")fail("native replacement original child changed");
  assertPredecessorAcceptanceAbsent(record);
  if(record.intent.authority.version===2)assertPredecessorAcceptanceAbsent(predecessorRecord(record.intent.authority));
}
function assertNativeReplacementAcceptanceAbsent(managerRoot:string,operationId:string):void {
  const directory=join(managerRoot,"transactions","manager-recovery-bindings");
  if(readdirSync(directory).some(name=>name===`${operationId}.acceptance.json`||name.startsWith(`${operationId}.acceptance.`)))
    fail("native replacement refuses an accepted original process");
}
/** Native-v2 failures use the same signed supersession, without inventing a
 * custom-backend repair child or editing the original journal/CAS. */
function captureUnacceptedNativeReplacementIntent(operationId:string,assertClosed:()=>void,existing?:NativeReplacementIntentV1):NativeReplacementIntentV1 {
  const managerRoot=canonicalTweakersManagerRoot(),evidence=readManagerAcceptedBackendRecoveryEvidence(managerRoot,operationId);
  const binding=evidence.binding,variant=join(managerRoot,"variants","tweakers"),journal:any=repairJson(managerRoot,binding.journal.path);
  const lane=journal.acceptedBackendTransition?.lane;
  assertAcceptedSharedNativeBackendTransitionShape(lane);
  if(evidence.committed||journal.phase!=="app:promoted"||lane.version!==2||lane.identity.brokerRoot!==defaultTweakersAccountsBrokerRoot())
    fail("native replacement requires one unaccepted promoted native generation");
  assertNativeReplacementAcceptanceAbsent(managerRoot,operationId);
  const worker=workerCustody(verifiedDoctorManagerLauncher(),pinnedReplacementLeaf());assertCurrentRepairWorker(worker);
  const operation=new ManagerOperationStore(managerRoot).read(operationId);if(!operation)fail("native replacement operation is absent");
  const createdAt=existing?.createdAt??new Date().toISOString();supersededNativeReplacementOperation(operation,createdAt);
  const buildRoot=join(variant,"builds",binding.promotionId),casRoot=join(buildRoot,"accepted-backend-transition");
  if(journal.buildRoot!==buildRoot)fail("native replacement build escaped original custody");
  const cas:any=repairJson(managerRoot,join(casRoot,"intent.json")),planHash=String(cas.planFingerprint).replace(/^sha256:/,"");
  if(cas.journalPath!==binding.journal.path||sha(cas.preparedJournalBytes)!==cas.preparedJournalSha256
    ||!isDeepStrictEqual(parseAcceptedRuntimeRepairJson(cas.preparedJournalBytes),{...journal,phase:"prepared"})||!/^[a-f0-9]{64}$/.test(planHash))fail("native replacement original CAS changed");
  const brokerRoot=lane.identity.brokerRoot,completed=join(brokerRoot,`shared-native-resolver-completed-${planHash}.json`),prior=join(brokerRoot,`shared-native-resolver-prior-${planHash}.json`);
  if(sha(readAcceptedRuntimeRepairPrivateFile(managerRoot,completed))!==planHash
    ||`sha256:${sha(readAcceptedRuntimeRepairPrivateFile(managerRoot,prior))}`!==lane.priorRegistrationFingerprint)fail("native replacement completed CAS changed");
  const validation=sharedNativeBackendTransitionPort(worker.runtimeRoot).executeSharedNativeResolverTransitionAtRootV1({stateRoot:brokerRoot,plan:cas.plan,expectedPlanFingerprint:cas.planFingerprint,action:"validate"});
  if(validation.state!=="validated"||validation.resolverBinarySha256!==lane.authority.backend.sha256)fail("native replacement signed resolver is not current");
  for(const entry of journal.entries)assertGeneration(entry.destination,entry.desired);
  assertGeneration(journal.activeReceipt.destination,journal.activeReceipt.previous);
  assertAcceptedSharedNativeBackendTransitionClosure(lane,"/Applications/Tweakers.app",join(variant,"runtime"));
  const receiptBundle=join(dirname(journal.candidate),"receipt","TweakersCandidateReceipt.bundle");
  verifyCandidateReceiptResourceBundle(receiptBundle,pinnedReplacementLeaf());
  const receipt:any=repairJson(managerRoot,join(receiptBundle,"Contents","Resources","variant-candidate-receipt.json"));
  const app=journal.entries.find((entry:{name:string})=>entry.name==="app"),previousPath=join(variant,"previous",binding.promotionId,"app","Tweakers.app");
  if(receipt.signingIdentityHash!==pinnedReplacementLeaf()||!isDeepStrictEqual(receipt.acceptedBackendTransition,lane)
    ||!isDeepStrictEqual(receipt.artifacts?.app,app?.desired)||!verifySignature("/Applications/Tweakers.app",pinnedReplacementLeaf()).ok
    ||app?.archive!==previousPath||!app.previous)fail("native replacement signed desktop custody changed");
  assertGeneration(previousPath,app.previous);
  const stat=lstatSync(previousPath),capacity=inspectLocalArtifactCapacity(managerRoot,"/Applications/Tweakers.app");
  const reservations=readReservations(managerRoot).filter(e=>e.state!=="retired"&&e.paths.includes(previousPath));
  if(stat.isSymbolicLink()||realpathSync(previousPath)!==previousPath||stat.uid!==process.getuid?.()||capacity.blockers.length||capacity.occupied!==2
    ||capacity.paths.length!==2||!capacity.paths.includes(previousPath)||!capacity.paths.includes("/Applications/Tweakers.app")
    ||reservations.length!==1||reservations[0]!.state!=="rollback"||reservations[0]!.transactionRef!==binding.journal.path
    ||!isDeepStrictEqual(reservations[0]!.generationIdentity,{dev:stat.dev,ino:stat.ino})||!isDeepStrictEqual(reservations[0]!.generationFingerprint,app.previous))fail("native replacement previous app capacity changed");
  const replacementId=existing?.replacementId??randomUUID();
  // An already registered supplied backend needs an ordinary reviewed refresh,
  // not a new resolver CAS. The authenticated native-v2 lane above owns it.
  const nativeRequest=prepareOfficialBundledBackendTransitionRequest({sourceAppRoot:"/Applications/ChatGPT.app",brokerRoot,runtimeRoot:worker.runtimeRoot,transactionId:replacementId})??null;
  const retainedPaths=[binding.journal.path,join(managerRoot,"transactions","manager-recovery-bindings",`${operationId}.json`),casRoot,completed,prior,receiptBundle];
  const unchangedPaths=[...journal.entries.map((entry:{destination:string})=>entry.destination),journal.activeReceipt.destination,join(variant,"runtime-ready-expectation.json"),join(brokerRoot,"shared-native-mode.v1.json")];
  const intent:NativeReplacementIntentV1={version:1,kind:"tweakers-native-replacement-intent",operationId,promotionId:binding.promotionId,repairId:null,replacementId,createdAt,
    trustedLeafSha1:pinnedReplacementLeaf(),worker:worker.worker,originalOperation:operation,retained:retainedPaths.map(path=>({path,generation:fingerprintVariantGeneration(path)})),
    unchanged:unchangedPaths.map(path=>({path,generation:fingerprintVariantGeneration(path)})),previousApp:{path:previousPath,destination:join(targetUserHome(),".Trash",`Tweakers-superseded-${replacementId}`,"Tweakers.app"),generation:app.previous,identity:{dev:stat.dev,ino:stat.ino}},nativeRequest};
  validateNativeReplacementIntent(intent,operationId);requireClosedRepairAdmission(assertClosed);return intent;
}
function captureNativeReplacementIntent(operationId:string,assertClosed:()=>void,existing?:NativeReplacementIntentV1):NativeReplacementIntentV1 {
  requireClosedRepairAdmission(assertClosed);
  const managerRoot=canonicalTweakersManagerRoot(),record=readAcceptedRuntimeRepairRecord(operationId);
  if(!record)return captureUnacceptedNativeReplacementIntent(operationId,assertClosed,existing);
  if(record.publication.phase!=="challenge:published")fail("native replacement requires an unaccepted published repair challenge");
  assertPreparedRuntimeRepairAuthority(record.root,record.intent.authority,true);
  assertPredecessorAcceptanceAbsent(record);
  const authority=record.intent.authority,journal=originalRepairJournal(record.root,authority),variant=join(managerRoot,"variants","tweakers");
  assertRepairedRuntime(record,join(variant,"runtime"));
  assertGeneration(journal.activeReceipt.destination,authority.unchanged.priorActiveReceipt);
  const worker=workerCustody(verifiedDoctorManagerLauncher(),pinnedReplacementLeaf());assertCurrentRepairWorker(worker);
  const replacementId=existing?.replacementId??randomUUID();
  const nativeRequest=prepareOfficialBundledBackendTransitionRequest({sourceAppRoot:"/Applications/ChatGPT.app",brokerRoot:defaultTweakersAccountsBrokerRoot(),runtimeRoot:worker.runtimeRoot,transactionId:replacementId});
  if(!nativeRequest)fail("native replacement requires a fresh official-bundled Doctor transition");
  const app=journal.entries.find((entry:{name:string})=>entry.name==="app"),previousPath=join(variant,"previous",record.head.promotionId,"app","Tweakers.app");
  if(app?.archive!==previousPath||!app.previous||app.destination!=="/Applications/Tweakers.app")fail("native replacement previous app is not exact journal custody");
  assertGeneration(previousPath,app.previous);
  const stat=lstatSync(previousPath),capacity=inspectLocalArtifactCapacity(managerRoot,"/Applications/Tweakers.app");
  const reservations=readReservations(managerRoot).filter(e=>e.state!=="retired"&&e.paths.includes(previousPath));
  if(stat.isSymbolicLink()||realpathSync(previousPath)!==previousPath||!stat.isDirectory()||stat.uid!==process.getuid?.()
    ||capacity.blockers.length||capacity.occupied!==2||capacity.paths.length!==2||!capacity.paths.includes(previousPath)||!capacity.paths.includes("/Applications/Tweakers.app")
    ||reservations.length!==1||reservations[0]!.state!=="rollback"||reservations[0]!.transactionRef!==authority.originals.journal.sourcePath
    ||!isDeepStrictEqual(reservations[0]!.generationIdentity,{dev:stat.dev,ino:stat.ino})||!isDeepStrictEqual(reservations[0]!.generationFingerprint,app.previous))fail("native replacement capacity or previous-app reservation changed");
  const retainedPaths=[record.root,authority.originals.journal.sourcePath,authority.originals.recoveryBinding.path];
  if(authority.version===2)retainedPaths.push(predecessorRecord(authority).root);
  const unchangedPaths=["/Applications/Tweakers.app",join(variant,"runtime"),join(variant,"tweaks"),join(variant,"state.json"),join(variant,"config.json"),journal.activeReceipt.destination,
    authority.completedCas.currentRegistration.path,join(variant,"runtime-ready-expectation.json")];
  const operation=new ManagerOperationStore(managerRoot).read(operationId);if(!operation)fail("native replacement operation is absent");
  const intent:NativeReplacementIntentV1={version:1,kind:"tweakers-native-replacement-intent",operationId,promotionId:record.head.promotionId,repairId:record.head.repairId,replacementId,
    createdAt:existing?.createdAt??new Date().toISOString(),trustedLeafSha1:authority.originalTrustedLeafSha1,worker:worker.worker,originalOperation:operation,
    retained:retainedPaths.map(path=>({path,generation:fingerprintVariantGeneration(path)})),unchanged:unchangedPaths.map(path=>({path,generation:fingerprintVariantGeneration(path)})),
    previousApp:{path:previousPath,destination:join(targetUserHome(),".Trash",`Tweakers-superseded-${replacementId}`,"Tweakers.app"),generation:app.previous,identity:{dev:stat.dev,ino:stat.ino}},nativeRequest};
  validateNativeReplacementIntent(intent,operationId);requireClosedRepairAdmission(assertClosed);return intent;
}
function nativeReplacementSettlement(intent:NativeReplacementIntentV1) {
  return {version:1,kind:"tweakers-native-replacement-settlement",operationId:intent.operationId,promotionId:intent.promotionId,repairId:intent.repairId,
    intentSha256:sha(canonicalManagerJson(intent)),originalOperation:supersededNativeReplacementOperation(intent.originalOperation,intent.createdAt),
    retiredApp:intent.previousApp,originalPromotionAccepted:false};
}
/** Caller must hold both desktop and broker admission plus the shared lifecycle
 * lock. Interrupted retirement replays from signed custody; no caller authority
 * or arbitrary root, app, source, runtime, or worker can enter this operation. */
export async function prepareAcceptedRuntimeNativeReplacement(operationId:string,assertClosed:()=>void):Promise<{operationId:string;promotionId:string;outcome:string;retiredApp:string;nativeBackendSha256:string}> {
  requireClosedRepairAdmission(assertClosed);
  const managerRoot=canonicalTweakersManagerRoot(),root=nativeReplacementRoot(operationId),store=new ManagerOperationStore(managerRoot);
  let intent:NativeReplacementIntentV1;
  const draft=join(root,"intent.json");
  if(existsSync(draft)) {
    const saved:unknown=repairJson(root,draft);validateNativeReplacementIntent(saved,operationId);intent=saved;
    if(store.read(operationId)?.phase==="recovery-required") {
      const observed=captureNativeReplacementIntent(operationId,assertClosed,intent);
      if(!isDeepStrictEqual(observed,intent))fail("native replacement draft changed; preserved for recovery");
      publishReplacementBundle(root,"intent",intent);
    }
  } else {
    intent=captureNativeReplacementIntent(operationId,assertClosed);
    privateDirectoryTree(managerRoot,root);immutableJson(root,draft,intent);publishReplacementBundle(root,"intent",intent);
  }
  if(!isDeepStrictEqual(replacementSignedJson(root,"intent"),intent))fail("native replacement intent signature differs");
  const currentWorker=workerCustody(verifiedDoctorManagerLauncher(),intent.trustedLeafSha1);assertCurrentRepairWorker(currentWorker);
  if(!isDeepStrictEqual(currentWorker.worker,intent.worker))fail("native replacement may only resume in its exact sealed worker");
  assertNativeReplacementRetained(intent);
  const failed=supersededNativeReplacementOperation(intent.originalOperation,intent.createdAt),current=store.read(operationId);
  if(!isDeepStrictEqual(current,intent.originalOperation)&&!isDeepStrictEqual(current,failed))fail("native replacement consumed operation changed");
  let settled=false;
  if(existsSync(replacementBundle(root,"settlement"))) {
    try{settled=isDeepStrictEqual(replacementSignedJson(root,"settlement"),nativeReplacementSettlement(intent));}
    catch{/* A partial signature can replay only after all retained and live custody below verifies. */}
  }
  if(settled) {
    if(!isDeepStrictEqual(current,failed))fail("native replacement settlement lacks its failed original operation");
  } else {
    for(const entry of intent.unchanged)assertGeneration(entry.path,entry.generation);
    const native=prepareOfficialBundledBackendTransitionRequest({sourceAppRoot:"/Applications/ChatGPT.app",brokerRoot:defaultTweakersAccountsBrokerRoot(),runtimeRoot:currentWorker.runtimeRoot,transactionId:intent.replacementId})??null;
    if(!isDeepStrictEqual(native,intent.nativeRequest))fail("native replacement supplied source or prior registration changed");
    const trash=join(targetUserHome(),".Trash");assertAcceptedRuntimeRepairPrivatePath(trash,trash,true);
    privateDirectoryTree(trash,dirname(intent.previousApp.destination));
    requireClosedRepairAdmission(assertClosed);
    const disposition=nativeReplacementRetirementDisposition(existsSync(intent.previousApp.path),existsSync(intent.previousApp.destination));
    const source=disposition==="move"?intent.previousApp.path:intent.previousApp.destination;
    const stat=lstatSync(source);
    if(stat.isSymbolicLink()||realpathSync(source)!==source||!stat.isDirectory()||stat.dev!==intent.previousApp.identity.dev||stat.ino!==intent.previousApp.identity.ino)fail("native replacement previous app identity changed");
    assertGeneration(source,intent.previousApp.generation);
    if(current?.phase==="recovery-required")store.replace(failed);
    // Recheck held admission and exact custody immediately before the only move.
    requireClosedRepairAdmission(assertClosed);assertNativeReplacementRetained(intent);
    if(disposition==="move") {
      assertGeneration(intent.previousApp.path,intent.previousApp.generation);
      renameSync(intent.previousApp.path,intent.previousApp.destination);
      syncDirectory(dirname(intent.previousApp.path));syncDirectory(dirname(intent.previousApp.destination));
    }
    assertGeneration(intent.previousApp.destination,intent.previousApp.generation);
    if(existsSync(intent.previousApp.path))fail("native replacement old app still has a local payload");
    const retirement=join(root,"retired.json"),settlement=nativeReplacementSettlement(intent);
    ensureImmutableJson(root,retirement,settlement);retireLocalArtifactAt(managerRoot,intent.previousApp.path,retirement);
    requireClosedRepairAdmission(assertClosed);publishReplacementBundle(root,"settlement",settlement);
  }
  if(!authenticateSupersededAcceptedRuntimeRepairPromotion(join(managerRoot,"variants","tweakers"),intent.promotionId,operationId))fail("native replacement settlement did not authenticate");
  publishLocalArtifactSnapshot(managerRoot,inspectLocalArtifactCapacity(managerRoot,"/Applications/Tweakers.app"));
  const originalJournal:any=repairJson(managerRoot,join(managerRoot,"variants","tweakers","transactions","variant-promotion",`${intent.promotionId}.json`));
  return{operationId,promotionId:intent.promotionId,outcome:"superseded-for-official-bundled-replacement",retiredApp:intent.previousApp.destination,
    nativeBackendSha256:intent.nativeRequest?.officialBundled.expectedBackendSha256??originalJournal.acceptedBackendTransition.lane.authority.backend.sha256};
}
/** Authenticate retained history only. No installed/fallback/runtime readiness
 * is inferred. A later ordinary native-backed promotion must pass its own gate. */
export function authenticateSupersededAcceptedRuntimeRepairPromotion(userRoot:string,promotionId:string,operationId:string):boolean {
  const managerRoot=canonicalTweakersManagerRoot();
  if(userRoot!==join(managerRoot,"variants","tweakers")||!isManagerOperationId(promotionId)||!isManagerOperationId(operationId))return false;
  const root=nativeReplacementRoot(operationId);if(!existsSync(join(root,"intent.json")))return false;
  const value=replacementSignedJson(root,"intent");validateNativeReplacementIntent(value,operationId);
  if(value.promotionId!==promotionId)fail("native replacement promotion differs");
  assertNativeReplacementRetained(value);
  if(!isDeepStrictEqual(replacementSignedJson(root,"settlement"),nativeReplacementSettlement(value))
    ||!isDeepStrictEqual(new ManagerOperationStore(managerRoot).read(operationId),supersededNativeReplacementOperation(value.originalOperation,value.createdAt)))fail("native replacement historical settlement differs");
  return true;
}

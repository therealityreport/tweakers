import { doctorImplementationScopes, sameDoctorCandidateImplementation } from "./doctor-implementation.js";
import { readDoctorAdoption } from "./doctor-adoption.js";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DoctorActionRequestV1, DoctorReportV1, DoctorFindingV1 } from "@therealityreport/tweakers-sdk";
import { isTweakersManagerSection, type TweakersManagerSection } from "@therealityreport/tweakers-sdk";
import { canonicalTweakersManagerRoot } from "./manager-descriptor.js";
import { targetUserHome } from "./ownership.js";
import { readPlist } from "./plist.js";
import { verifySignature } from "./codesign.js";
import { readHeaderHash } from "./asar.js";
import { inspectAccountRouter, inspectIndependentTweakersLiveHealth } from "./account-router-status.js";
import { packagedRuntimeAssetsRoot } from "./commands/install.js";
import { readRuntimeFingerprintEvidence } from "./runtime-fingerprint.js";
import { ManagerOperationStore } from "./manager-operation-store.js";
import { doctorDigest, doctorDirectory, readDoctorPrivateJson, readDoctorUpdateJob } from "./doctor-store.js";

export const DOCTOR_APP = "/Applications/Tweakers.app";
export const DOCTOR_NATIVE_APP = "/Applications/ChatGPT.app";
export interface DoctorStorageStatus {
  state: "ready" | "repairable" | "blocked" | "not_applicable";
  reason: string; fingerprint: string; legacyVolumeUnproven: boolean;
}
interface StoragePort {
  inspectNativeStorageIdentitiesAtRoot(root: string): DoctorStorageStatus;
  repairNativeStorageIdentitiesAtRoot(root: string, expectedFingerprint: string): Promise<DoctorStorageStatus>;
}
export function loadDoctorStoragePort(): StoragePort {
  return createRequire(import.meta.url)(join(packagedRuntimeAssetsRoot(), "account-router", "doctor-storage.js")) as StoragePort;
}
export interface DoctorAuthStatus {
  state: "ready" | "reconnect_required" | "blocked";
  fingerprint: string; accounts: { accountId: string; label: string }[];
}
export function loadDoctorAuthPort(): {
  inspectNativeAuthenticationAtRoot(root: string): DoctorAuthStatus;
  reconnectNativeAuthenticationAtRoot(input: { root: string; accountId: string; expectedFingerprint: string; prepareDesktop?: () => Promise<void>; login: (home: string) => Promise<void> }): Promise<DoctorAuthStatus>;
} {
  return createRequire(import.meta.url)(join(packagedRuntimeAssetsRoot(), "account-router", "doctor-auth.js"));
}
export function doctorBundleIdentity(appPath: string): string {
  const info = readPlist(join(appPath, "Contents", "Info.plist"));
  const backend = lstatSync(join(appPath, "Contents", "Resources", "codex"));
  const asar = lstatSync(join(appPath, "Contents", "Resources", "app.asar"));
  return doctorDigest({ appPath, info, asar: readHeaderHash(join(appPath, "Contents", "Resources", "app.asar")).headerHash,
    asarStat: { ino: asar.ino, dev: asar.dev, size: asar.size, ctimeMs: asar.ctimeMs, mtimeMs: asar.mtimeMs },
    signature: readFileSync(join(appPath, "Contents", "_CodeSignature", "CodeResources")).toString("base64"),
    backend: { ino: backend.ino, dev: backend.dev, size: backend.size, ctimeMs: backend.ctimeMs, mtimeMs: backend.mtimeMs } });
}
export interface DoctorIndependentInputs {
  root: string; variantRoot: string; runtimeRoot: string; brokerRoot: string;
  version: string; build: string; nativeVersion: string | null; nativeBuild: string | null;
  originalAsarHash: string; installedIdentity: string; nativeIdentity: string | null; runtimeFingerprint: string;
}
export function readDoctorIndependentInputs(root = canonicalTweakersManagerRoot()): DoctorIndependentInputs {
  if (realpathSync(root) !== resolve(root)) throw new Error("Doctor manager root is not canonical");
  const variantRoot = join(root, "variants", "tweakers"), runtimeRoot = join(variantRoot, "runtime");
  const brokerRoot = join(root, "tweak-data", "co.tweakers.account-switcher");
  const info = readPlist(join(DOCTOR_APP, "Contents", "Info.plist"));
  if (info.CFBundleIdentifier !== "com.therealityreport.tweakers" || !verifySignature(DOCTOR_APP).ok) throw new Error("Independent Tweakers signature or bundle identity is invalid");
  const state = readDoctorPrivateJson(join(variantRoot, "state.json")) as Record<string, unknown> | null;
  if (!state || state.appRoot !== DOCTOR_APP || typeof state.originalAsarHash !== "string"
    || state.patchedAsarHash !== readHeaderHash(join(DOCTOR_APP, "Contents", "Resources", "app.asar")).headerHash) throw new Error("Independent app and variant state do not match");
  const signed = join(DOCTOR_APP, "Contents", "Resources", "tweakers");
  if (readFileSync(join(signed, "variant-accounts-broker-root"), "utf8").trim() !== brokerRoot
    || readFileSync(join(signed, "variant-user-data-path"), "utf8").trim() !== join(variantRoot, "app-data")
    || readFileSync(join(signed, "variant-codex-home-path"), "utf8").trim() !== join(variantRoot, "codex-home")) throw new Error("Independent app is bound to a different account or variant root");
  const runtime = readRuntimeFingerprintEvidence(packagedRuntimeAssetsRoot());
  if (!runtime) throw new Error("Doctor packaged runtime fingerprint is invalid");
  let nativeVersion: string | null = null, nativeBuild: string | null = null, nativeIdentity: string | null = null;
  try {
    const native = readPlist(join(DOCTOR_NATIVE_APP, "Contents", "Info.plist"));
    if (native.CFBundleIdentifier === "com.openai.codex") {
      nativeVersion = String(native.CFBundleShortVersionString); nativeBuild = String(native.CFBundleVersion);
      nativeIdentity = doctorBundleIdentity(DOCTOR_NATIVE_APP);
    }
  } catch { /* Missing native app is a diagnostic finding, never a legacy fallback. */ }
  return { root, variantRoot, runtimeRoot, brokerRoot, version: String(info.CFBundleShortVersionString), build: String(info.CFBundleVersion),
    nativeVersion, nativeBuild, originalAsarHash: state.originalAsarHash, nativeIdentity,
    installedIdentity: doctorBundleIdentity(DOCTOR_APP), runtimeFingerprint: runtime.fingerprint };
}
const blankUpdate = (): DoctorReportV1["update"] => ({ state: "not_checked", phase: "idle", candidateId: null,
  sourceFingerprint: null, tweakersFingerprint: null, candidateFingerprint: null, reviewFingerprint: null, progress: "No update review yet.", usage: null, handoff: null });
export interface DoctorInspectionDependencies {
  inputs?: typeof readDoctorIndependentInputs;
  storage?: typeof loadDoctorStoragePort;
  accounts?: typeof inspectAccountRouter;
  liveHealth?: typeof inspectIndependentTweakersLiveHealth;
}
export async function inspectIndependentDoctor(root = canonicalTweakersManagerRoot(), deps: DoctorInspectionDependencies = {}): Promise<DoctorReportV1> {
  const findings: DoctorFindingV1[] = [];
  const add = (id: string, stage: DoctorFindingV1["stage"], reason: string, title: string, detail: string, severity: DoctorFindingV1["severity"] = "error") => findings.push({ id, stage, severity, reason, title, detail, evidence: [] });
  let input: DoctorIndependentInputs | null = null, storage: DoctorStorageStatus | null = null;
  let authentication: DoctorAuthStatus | null = null;
  let reviewWorkerRunning = false;
  let broker = "unavailable", health: DoctorReportV1["health"]["state"] = "blocked", update = blankUpdate();
  try { input = (deps.inputs ?? readDoctorIndependentInputs)(root); }
  catch (error) { add("independent.installation", "installation", "target_invalid", "Independent installation needs attention", error instanceof Error ? error.message : "The independent target is unavailable."); }
  if (input) {
    try {
      storage = (deps.storage ?? loadDoctorStoragePort)().inspectNativeStorageIdentitiesAtRoot(input.brokerRoot);
      if (storage.state !== "ready") add("independent.storage", "storage", storage.reason,
        storage.state === "repairable" ? "Storage binding repair available" : "Storage binding needs attention",
        storage.legacyVolumeUnproven
          ? "The signed account bindings can be verified. Repair records persistent volume identities without changing credentials or history. Legacy records cannot prove the previous volume UUID."
          : `Storage preflight: ${storage.reason.replaceAll("_", " ")}.`, storage.state === "repairable" ? "warning" : "error");
    } catch { add("independent.storage", "storage", "inspector_unavailable", "Storage inspector unavailable", "The managed runtime must include the independent Doctor storage inspector."); }
    if (storage?.reason === "authentication_binding_invalid") {
      try {
        authentication = loadDoctorAuthPort().inspectNativeAuthenticationAtRoot(input.brokerRoot);
        for (const account of authentication.accounts) add(`independent.auth.${account.accountId}`, "broker", "authentication_recovery_required", `${account.label} needs to reconnect`, "Reconnect closes Tweakers, then asks you to sign into the original account. A login to your other account will be rejected; both accounts and their history are preserved.");
      } catch { /* Older packages remain blocked rather than guessing recovery authority. */ }
    }
    const account = await (deps.accounts ?? inspectAccountRouter)({ userRoot: root, brokerRoot: input.brokerRoot, installedRuntimeRoot: input.runtimeRoot });
    broker = account.broker.state === "active" ? account.broker.status?.state ?? "unavailable" : account.broker.state;
    const live = (deps.liveHealth ?? inspectIndependentTweakersLiveHealth)(input.variantRoot, { expectedAccountsBrokerRoot: input.brokerRoot });
    if (broker !== "available") add("independent.broker", "broker", broker === "incompatible" ? "protocol_incompatible" : "broker_unavailable", "Accounts broker unavailable", "The broker did not answer a fresh authenticated readiness check. Resolve the storage finding before retrying startup.");
    if (live.state !== "current" || live.health.sharedHistoryBrokerState !== "connected") add("independent.live", "broker", "fresh_readiness_missing", "Fresh app readiness is missing", "An old health receipt or a running process does not prove the app is ready.", "warning");
    health = findings.some(f => f.severity === "error") ? "blocked" : findings.length ? "attention" : "healthy";
    try {
      const job = readDoctorUpdateJob(root);
      if (job) {
        update = { ...job.result };
        const baselineChanged = job.baselineIdentity
          ? job.baselineIdentity !== doctorDigest({ version: input.version, build: input.build, originalAsarHash: input.originalAsarHash })
          : job.installedIdentity !== input.installedIdentity;
        const stale = (job.workflowVersion !== 2 && job.nativeIdentity !== input.nativeIdentity) || baselineChanged;
        const customizationChanged = !sameDoctorCandidateImplementation(job.implementationScopes, doctorImplementationScopes()) || job.installedIdentity !== input.installedIdentity;
        if (!stale && customizationChanged) {
          update.state = "review_required"; update.phase = "revalidation_required";
          if (update.execution) update.execution = { ...update.execution, status: "action_required", recoverable: true };
          update.progress = "Saved upstream changes are available. Check for updates to verify them with the current Tweakers customizations.";
          add("independent.update.revalidation", "compatibility", "customization_changed", "Verify current customizations", update.progress, "warning");
        }
        let running = true;
        if (job.result.state === "checking") { try { process.kill(job.pid, 0); } catch {
          // The detached launcher hands execution to its worker. Keep the UI
          // following that bounded handoff, never a missing established worker.
          running = ["settling", "resuming"].includes(job.result.phase ?? "")
            && Date.now() - Date.parse(job.updatedAt) < 30_000;
        } }
        reviewWorkerRunning = job.result.state === "checking" && running;
        if (stale || !running || (job.result.state === "checking" && Date.now() - Date.parse(job.updatedAt) > 25 * 60_000)) {
          update.state = "review_required"; update.phase = "stale"; update.progress = stale ? "Update inputs changed. Choose Check for updates to prepare a fresh review." : "Review was interrupted. Choose Check for updates to resume saved checkpoints.";
          if (update.execution) update.execution = { ...update.execution, status: stale ? "superseded" : "action_required", recoverable: true };
          add("independent.update.stale", "compatibility", "stale_evidence", "Update review needs refreshing", update.progress, "warning");
        } else {
          findings.push(...job.findings);
          if ((update.state === "review_required" || update.state === "fixes_required") && !job.findings.some(finding => finding.stage === "compatibility")) {
            add("independent.update.unresolved", "compatibility", "incomplete_review", "Update compatibility is unresolved",
              update.progress || "This saved review has no detailed findings. Scan again to collect complete evidence and compatibility checks.", "warning");
          }
        }
      }
    } catch { update.state = "review_required"; update.progress = "Saved update evidence is invalid. Scan again."; }
  }
  const repairEnabled = !!input && storage?.state === "repairable" && broker !== "available" && broker !== "incompatible";
  let updateEnabled = false;
  const installationBlockers: string[] = [];
  if (input && update.state === "compatible" && update.phase === "candidate_verified" && update.candidateFingerprint) {
    try { (await import("./doctor-approval.js")).verifyDoctorCandidate(root, undefined, false); updateEnabled = true; }
    catch (error) { update.state = "review_required"; update.phase = "stale"; update.progress = "Candidate or compatibility evidence changed. Scan again."; installationBlockers.push(error instanceof Error ? error.message : update.progress); }
  }
  try {
    const submitted = readDoctorPrivateJson(join(doctorDirectory(root), "update-operation.json")) as { operationId?: string; jobId?: string } | null;
    if (submitted?.jobId === update.candidateId && submitted?.operationId) {
      const operation = new ManagerOperationStore(root).read(submitted.operationId);
      if (operation?.phase === "prepared" || operation?.phase === "consumed") {
        updateEnabled = false; update.state = "checking"; update.phase = "updating"; update.progress = "The manager is applying the approved candidate and verifying startup.";
        installationBlockers.push(update.progress);
      } else if (operation?.phase === "completed" && operation.actionId === "refresh.independent" && input && health === "healthy") {
        const installedJob = readDoctorUpdateJob(root);
        const active = readDoctorPrivateJson(join(input.variantRoot, "transactions", "variant-promotion", "active.json"));
        const { fingerprintVariantGeneration } = await import("./commands/create-variant.js");
        const observed = { app: fingerprintVariantGeneration(DOCTOR_APP), runtime: fingerprintVariantGeneration(input.runtimeRoot) };
        if (completedCandidateMatchesActiveReceipt(installedJob?.candidateReceipt, active, input.variantRoot, observed)) {
          updateEnabled = false; update.state = "compatible"; update.phase = "installed";
          update.progress = "Update installed and startup verified."; update.execution = undefined;
          installationBlockers.splice(0, installationBlockers.length, "This candidate is already installed.");
          for (let i = findings.length - 1; i >= 0; i--) if (["independent.update.stale", "independent.update.revalidation", "independent.update.unresolved"].includes(findings[i]!.id)) findings.splice(i, 1);
        }
      } else if (operation?.phase === "failed" || operation?.phase === "recovery-required") {
        updateEnabled = false; update.state = "review_required"; update.phase = "promotion_failed";
        update.progress = operation.error ? `Installation stopped: ${operation.error}` : "The update did not complete. Inspect manager recovery findings before retrying.";
        installationBlockers.push(update.progress);
        add("independent.update.promotion", "candidate", "promotion_failed", "Update needs attention", update.progress);
      }
    }
  } catch { updateEnabled = false; }
  let adoption: DoctorReportV1["adoption"] = null;
  try { adoption = readDoctorAdoption(root); } catch { updateEnabled = false; }
  if (adoption && update.phase === "stale") adoption = { ...adoption, state: "superseded", blockers: ["This update report has been superseded; wait for the newest comparison."] };
  if (adoption) {
    try {
      const { readDoctorReviewUsage } = await import("./doctor-review-budget.js");
      const r = adoption.report;
      const ledger = readDoctorReviewUsage(join(doctorDirectory(root), "review-cache"), doctorDigest({ policy: 3, before: r.beforeFingerprint, after: r.afterFingerprint }));
      update.usageDetails = { version: 1, allowances: 1 + (ledger.extensions?.length ?? 0), requests: ledger.requests.map(entry => ({ id: entry.id, reservedAt: entry.reservedAt, settledAt: entry.settledAt ?? null,
        inputTokens: entry.usage?.inputTokens ?? null, cachedInputTokens: entry.cachedInputTokens ?? null, outputTokens: entry.usage?.outputTokens ?? null,
        model: entry.actualModel ?? null, effort: entry.actualEffort ?? null, configuredModel: entry.metadata?.configuredModel ?? null,
        configuredEffort: entry.metadata?.configuredEffort ?? null, stage: entry.metadata?.stage ?? null })) };
    } catch { /* Missing or invalid detailed usage is not reported as zero. */ }
  }
  const previewJob = readDoctorUpdateJob(root);
  const previewEnabled = !!adoption && adoption.state !== "superseded" && !!previewJob?.sourcePath && !!previewJob?.baselinePath && sameDoctorCandidateImplementation(previewJob.implementationScopes, doctorImplementationScopes()) && update.state !== "checking";
  updateEnabled = updateEnabled && adoption?.state === "ready";
  const adoptionEnabled = !!adoption && adoption.state !== "superseded" && update.phase !== "updating" && update.state !== "checking";
  const report: DoctorReportV1 = { schemaVersion: 1, workflowVersion: 2, kind: "tweakers-independent-doctor", generatedAt: new Date().toISOString(), fingerprint: "",
    target: { kind: "independent", appPath: DOCTOR_APP, version: input?.version ?? null, build: input?.build ?? null,
      runtimeRoot: input?.runtimeRoot ?? null, brokerRoot: input?.brokerRoot ?? null, nativeAppPath: DOCTOR_NATIVE_APP,
      nativeVersion: input?.nativeVersion ?? null, nativeBuild: input?.nativeBuild ?? null },
    health: { state: health, broker }, update, adoption, findings, actions: [
      { id: "reconnect", label: `Reconnect ${authentication?.accounts[0]?.label ?? "account"}`, enabled: authentication?.state === "reconnect_required" && broker !== "incompatible", blockers: authentication?.state === "reconnect_required" ? [] : ["No verified account reconnect is available."] },
      { id: "scan", label: "Check for updates", enabled: !!input && !reviewWorkerRunning && update.state !== "checking" && update.phase !== "updating", blockers: input ? reviewWorkerRunning || update.state === "checking" || update.phase === "updating" ? ["An update check or installation is already running. Reload status to see its progress."] : [] : ["Verify the independent installation first."] },
      { id: "repair", label: "Repair storage binding", enabled: repairEnabled, blockers: repairEnabled ? [] : [storage?.state === "repairable" ? "The Accounts broker must be idle before metadata repair." : "No verified metadata-only repair is available."] },
      { id: "retry", label: "Retry Tweakers", enabled: !!input && storage?.state === "ready", blockers: storage?.state === "ready" ? [] : ["Resolve storage preflight before retrying."] },
      { id: "update", label: "Install verified update", enabled: updateEnabled, blockers: updateEnabled ? [] : [...new Set([...(adoption?.blockers ?? []), ...(installationBlockers.length ? installationBlockers : ["Compatibility and candidate verification must also pass."])])] },
      { id: "decide", label: "Optional update changes", enabled: adoptionEnabled, blockers: adoptionEnabled ? [] : ["Wait for a current change report."] },
      { id: "preview_before", label: "Preview current version", enabled: previewEnabled, blockers: previewEnabled ? [] : ["Verify the candidate and retained source before previewing."] },
      { id: "preview_after", label: "Preview update", enabled: previewEnabled, blockers: previewEnabled ? [] : ["Verify the candidate and retained source before previewing."] },
      { id: "observe", label: "Record manual comparison", enabled: adoptionEnabled, blockers: adoptionEnabled ? [] : ["Wait for a current change report."] },
    ] };
  report.fingerprint = doctorDigest({ input, storage, authentication, health: report.health, update, adoption, findings, actions: report.actions });
  return report;
}

export function parseDoctorAction(value: unknown): DoctorActionRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Doctor action");
  const request = value as DoctorActionRequestV1;
  const keys = request.action === "decide" ? "action,decision,fingerprint,schemaVersion" : request.action === "observe" ? "action,fingerprint,observation,schemaVersion" : request.action === "scan" && request.scanTrigger !== undefined ? (request.availableUpdateBuild === undefined ? "action,fingerprint,scanTrigger,schemaVersion" : "action,availableUpdateBuild,fingerprint,scanTrigger,schemaVersion") : "action,fingerprint,schemaVersion";
  if (Object.keys(value).sort().join() !== keys || request.schemaVersion !== 1 || !["reconnect", "scan", "repair", "retry", "update", "decide", "observe", "preview_before", "preview_after"].includes(request.action)
    || !/^sha256:[a-f0-9]{64}$/.test(request.fingerprint)) throw new Error("Invalid Doctor action");
  if (request.scanTrigger !== undefined && (request.action !== "scan" || request.scanTrigger !== "available_update")) throw new Error("Invalid scan trigger");
  if (request.availableUpdateBuild !== undefined && (request.scanTrigger !== "available_update" || !/^[0-9]{1,20}$/.test(request.availableUpdateBuild))) throw new Error("Invalid available update build");
  const text = (v: unknown, max = 4096) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  if (request.action === "decide") {
    const d = request.decision;
    if (!d || !text(d.reportFingerprint, 80) || !/^sha256:[a-f0-9]{64}$/.test(d.reportFingerprint) || !text(d.changeId, 256)
      || !["accept", "acknowledge_unknown", "preserve", "override", "defer", "resume", "accept_explained", "extend_budget"].includes(d.choice)
      || Object.keys(d).sort().join() !== (d.overrideId === undefined ? "changeId,choice,reportFingerprint" : "changeId,choice,overrideId,reportFingerprint")
      || (d.choice === "override" ? !text(d.overrideId, 256) : d.overrideId !== undefined)) throw new Error("Invalid adoption decision");
  }
  if (request.action === "observe") {
    const o = request.observation;
    if (!o || Object.keys(o).sort().join() !== "after,before,changeId,conditions,outcome,reportFingerprint" || !/^sha256:[a-f0-9]{64}$/.test(o.reportFingerprint)
      || !text(o.changeId, 256) || ![o.before, o.after, o.conditions].every(v => text(v)) || !["matches", "differs", "unavailable"].includes(o.outcome)) throw new Error("Invalid manual observation");
  }
  return request;
}
export function openIndependentDoctorWindow(managerLauncher: string, section?: TweakersManagerSection): void {
  if (section !== undefined && !isTweakersManagerSection(section)) throw new Error("Invalid Manager section");
  const helper = join(packagedRuntimeAssetsRoot(), "native", "Tweakers Doctor.app", "Contents", "MacOS", "Tweakers Doctor");
  if (!existsSync(helper) || lstatSync(helper).isSymbolicLink()) throw new Error("Standalone Doctor is not packaged");
  const child = spawn(helper, [managerLauncher, ...(section ? ["--section", section] : [])], { detached: true, stdio: "ignore", env: { HOME: targetUserHome(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  child.unref();
}

/** This historical preflight failure occurred before staging, cutover, or account writes. */
export function isAccountsRecoveryPreflightFailure(operation: ReturnType<ManagerOperationStore["read"]>): boolean {
  if (!operation || operation.actionId !== "refresh.independent" || operation.phase !== "recovery-required"
    || !operation.error?.startsWith("Independent Tweakers refresh requires a source-bound validated Accounts recovery receipt in the sealed runtime.")) return false;
  const phases = operation.timing?.phases;
  return !!phases && ["source-validation", "apfs-clone", "patch-stage", "sign", "verify", "quiesce-promote", "runtime-ready-wait"].every(key => {
    const phase = phases[key as keyof typeof phases];
    return phase?.state === "skipped" && phase.startedAt === null && phase.completedAt === null;
  });
}

/** The committed active receipt must identify the exact app and runtime that passed review. */
export function completedCandidateMatchesActiveReceipt(candidate: unknown, active: unknown, variantRoot: string, observed: Record<"app" | "runtime", unknown>): boolean {
  if (!candidate || typeof candidate !== "object" || !active || typeof active !== "object") return false;
  const c = candidate as { identity?: { appTarget?: string; userRoot?: string }; artifacts?: Record<string, unknown> };
  const a = active as { version?: number; target?: string; userRoot?: string; entries?: Array<{name?: string; path?: string; fingerprint?: unknown}> };
  if (a.version !== 3 || a.target !== DOCTOR_APP || a.userRoot !== variantRoot || c.identity?.appTarget !== DOCTOR_APP || c.identity.userRoot !== variantRoot || !Array.isArray(a.entries)) return false;
  return ["app", "runtime"].every(name => {
    const matches = a.entries!.filter(e => e.name === name);
    return matches.length === 1 && matches[0]!.path === (name === "app" ? DOCTOR_APP : join(variantRoot, "runtime"))
      && c.artifacts?.[name] !== undefined && doctorDigest(matches[0]!.fingerprint) === doctorDigest(c.artifacts[name])
      && doctorDigest(observed[name as "app" | "runtime"]) === doctorDigest(c.artifacts[name]);
  });
}

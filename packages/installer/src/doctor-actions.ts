import { recordDoctorCandidateOverride } from "./doctor-store.js";
import { isCandidateCopyPrecutoverFailure } from "./manager-operation-store.js";
import { compatibilityFingerprint } from "./doctor-compatibility.js";
import { acquireProcessLock } from "./process-lock.js";
import { applyDoctorAdoptionAction, saveDoctorChangeReport } from "./doctor-adoption.js";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTweakersManagerSection, type TweakersManagerSection, type DoctorReportV1 } from "@therealityreport/tweakers-sdk";
import type { ManagerResolvedExecutableIdentityV1 } from "./manager-contract.js";
import { canonicalTweakersManagerRoot, parseTweakersManagerDescriptor, tweakersManagerDescriptorPaths, TWEAKERS_MANAGER_LAUNCHER_DESIGNATED_REQUIREMENT } from "./manager-descriptor.js";
import { ManagerOperationStore } from "./manager-operation-store.js";
import { createSealedTweakersManagerActionAdapter } from "./manager-action-adapter.js";
import { createTweakersManagerStatusSnapshot, managerStatusPaths } from "./manager-status.js";
import { isAccountsRecoveryPreflightFailure, inspectIndependentDoctor, loadDoctorStoragePort, loadDoctorAuthPort, openIndependentDoctorWindow, parseDoctorAction, readDoctorIndependentInputs, DOCTOR_APP } from "./doctor-independent.js";
import { approveDoctorCandidate, cancelDoctorCandidateApproval } from "./doctor-approval.js";
import { runDoctorUpdateJob, startDoctorUpdateScan } from "./doctor-updates.js";
import { doctorDigest, doctorDirectory, readDoctorPrivateJson, readDoctorUpdateJob, writeDoctorPrivateJson, writeDoctorUpdateJob } from "./doctor-store.js";

export function verifiedDoctorManagerLauncher(root = canonicalTweakersManagerRoot()): string {
  const paths = tweakersManagerDescriptorPaths(root);
  const descriptor = parseTweakersManagerDescriptor(readFileSync(paths.descriptorFile, "utf8"));
  const launcher = descriptor.executable;
  const generation = dirname(launcher);
  if (dirname(generation) !== paths.generationsRoot || join(generation, "Tweakers Manager Launcher") !== launcher || realpathSync(launcher) !== launcher) throw new Error("Doctor manager launcher is not the canonical sealed generation");
  const stat = lstatSync(launcher);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error("Doctor manager launcher is unsafe");
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${TWEAKERS_MANAGER_LAUNCHER_DESIGNATED_REQUIREMENT}`, launcher], { stdio: "pipe", timeout: 10_000, env: {} });
  return launcher;
}
export async function runDoctorManagerCommand(input: {
  command: "doctor-status" | "doctor-action" | "doctor-open" | "doctor-run" | "manager-open";
  section?: TweakersManagerSection;
  requestId: string; root: string; executable: ManagerResolvedExecutableIdentityV1; input?: unknown;
}): Promise<DoctorReportV1> {
  if (input.command === "doctor-run") await runDoctorUpdateJob(input.root, input.requestId, input.executable);
  if (input.command === "doctor-open") openIndependentDoctorWindow(input.executable.path);
  if (input.command === "manager-open") {
    if (!isTweakersManagerSection(input.section)) throw new Error("Invalid Manager section");
    openIndependentDoctorWindow(input.executable.path, input.section);
  }
  const report = await inspectIndependentDoctor(input.root);
  if (input.command !== "doctor-action") return report;
  const request = parseDoctorAction(input.input);
  if (request.fingerprint !== report.fingerprint) throw new Error("Doctor findings changed. Refresh before acting.");
  if (!report.actions.find(action => action.id === request.action)?.enabled) throw new Error("Doctor action is blocked by the current findings");
  const target = readDoctorIndependentInputs(input.root);
  if (request.action === "decide" && request.decision?.choice === "extend_budget") {
    if (!report.adoption || report.adoption.report.fingerprint !== request.decision.reportFingerprint) throw new Error("Refresh the current review before extending its allowance");
    const { extendDoctorReviewAllowance } = await import("./doctor-review-budget.js");
    const { doctorDigest } = await import("./doctor-store.js");
    const r = report.adoption.report;
    extendDoctorReviewAllowance(join(doctorDirectory(input.root), "review-cache"), doctorDigest({ policy: 3, before: r.beforeFingerprint, after: r.afterFingerprint }), request.fingerprint);
    startDoctorUpdateScan(input.root, input.executable, true, { resumeOnly: true });
  }
  else if (request.action === "decide" && request.decision?.choice === "override") {
    const { titlebarOverrideEnabled, TITLEBAR_CHANGE_ID, addDoctorTitlebarOptions } = await import("./doctor-overrides.js");
    const { verifyDoctorPreparedCandidate } = await import("./doctor-approval.js");
    const { setDoctorCandidateTitlebarEnabled } = await import("./commands/create-variant.js");
    const d = request.decision, change = report.adoption?.report.changes.find(c => c.id === d.changeId);
    if (!report.adoption || d.reportFingerprint !== report.adoption.report.fingerprint || d.changeId !== TITLEBAR_CHANGE_ID || !change?.overrides.some(o => o.id === d.overrideId)) throw new Error("No candidate-verified override adapter is available");
    const lock = acquireProcessLock(join(doctorDirectory(input.root), "candidate-mutation.lock"));
    try {
      const approval = readDoctorPrivateJson(join(doctorDirectory(input.root), "approval.json")) as { expiresAt?: string } | null;
      if (approval?.expiresAt && Date.parse(approval.expiresAt) > Date.now()) throw new Error("An installation is approved; wait for it to finish before changing settings");
      const { job, receipt } = verifyDoctorPreparedCandidate(input.root);
      const priorResult = { ...job.result };
      job.result.state = "checking"; job.result.phase = "applying_override";
      writeDoctorUpdateJob(input.root, job); // Invalidates any older approval before mutation.
      try {
        const updated = setDoctorCandidateTitlebarEnabled(job.candidatePackage!, receipt, titlebarOverrideEnabled(d.overrideId!));
        recordDoctorCandidateOverride(input.root, job.id, doctorDigest(receipt), doctorDigest(updated), d.overrideId!);
        job.candidateReceipt = updated;
        job.result = { ...priorResult, candidateFingerprint: doctorDigest(updated) };
        if (job.result.compatibility) {
          job.result.compatibility = structuredClone(job.result.compatibility);
          job.result.compatibility.binding.candidateFingerprint = job.result.candidateFingerprint;
          job.result.compatibility.fingerprint = compatibilityFingerprint(job.result.compatibility);
          job.result.reviewFingerprint = job.result.compatibility.fingerprint;
          writeDoctorPrivateJson(join(doctorDirectory(input.root), "jobs", job.id, "compatibility.json"), job.result.compatibility);
        }
        job.lastCompletedResult = undefined;
        const changes = structuredClone(report.adoption.report);
        changes.candidateFingerprint = job.result.candidateFingerprint;
        addDoctorTitlebarOptions(changes, job, join(target.variantRoot, "config.json"));
        saveDoctorChangeReport(input.root, job, changes);
        writeDoctorUpdateJob(input.root, job);
        applyDoctorAdoptionAction(input.root, { ...request, decision: { ...d, reportFingerprint: changes.fingerprint } });
      } catch (error) {
        job.result.state = "review_required"; job.result.phase = "override_incomplete"; job.result.progress = "The candidate setting could not be verified. Check for updates to regenerate the disposable candidate.";
        writeDoctorUpdateJob(input.root, job); throw error;
      }
    } finally { lock.release(); }
  }
  else if (request.action === "decide" || request.action === "observe") applyDoctorAdoptionAction(input.root, request);
  else if (request.action === "preview_before" || request.action === "preview_after") {
    if (!report.adoption) throw new Error("No current change report");
    await (await import("./doctor-preview.js")).openDoctorPreview(input.root, report.adoption.report.fingerprint, request.action === "preview_before" ? "before" : "after");
  }
  else if (request.action === "scan") {
    const operationPath = join(doctorDirectory(input.root), "update-operation.json");
    const submitted = readDoctorPrivateJson(operationPath) as { operationId?: string; jobId?: string } | null;
    const previous = readDoctorUpdateJob(input.root);
    // Only a deliberate retry after fresh healthy rollback can retire a failed attempt.
    // The exact Accounts preflight rejection also proves no staging or cutover began; preserve its receipt in history.
    const failedOperation = submitted?.operationId ? new ManagerOperationStore(input.root).read(submitted.operationId) : null;
    if (!request.scanTrigger && report.health.state === "healthy" && previous
      && submitted?.jobId === previous.id && submitted.operationId
      && (isAccountsRecoveryPreflightFailure(failedOperation) || isCandidateCopyPrecutoverFailure(failedOperation)
        || (previous.installedIdentity === target.installedIdentity && failedOperation?.phase === "failed"))) {
      const history = join(doctorDirectory(input.root), "jobs", previous.id, "installation-attempts");
      mkdirSync(history, { recursive: true, mode: 0o700 });
      renameSync(operationPath, join(history, `${randomUUID()}.json`));
    }
    startDoctorUpdateScan(input.root, input.executable, true, { trigger: request.scanTrigger ?? "manual", availableUpdateBuild: request.availableUpdateBuild });
  }
  else if (request.action === "reconnect") {
    const auth = loadDoctorAuthPort();
    const before = auth.inspectNativeAuthenticationAtRoot(target.brokerRoot);
    const account = before.accounts[0];
    if (before.state !== "reconnect_required" || !account || (await inspectIndependentDoctor(input.root)).fingerprint !== request.fingerprint) throw new Error("Account recovery findings changed. Refresh Doctor.");
    const { runDoctorAccountLogin } = await import("./doctor-auth.js");
    await auth.reconnectNativeAuthenticationAtRoot({ root: target.brokerRoot, accountId: account.accountId, expectedFingerprint: before.fingerprint,
      prepareDesktop: async () => {
        execFileSync("/usr/bin/osascript", ["-e", 'if application "/Applications/Tweakers.app" is running then tell application "/Applications/Tweakers.app" to quit'], { stdio: "ignore", timeout: 10_000, env: {} });
      },
      login: home => runDoctorAccountLogin(join(DOCTOR_APP, "Contents", "Resources", "codex"), home, account.label) });
  }
  else if (request.action === "repair") {
    const storage = loadDoctorStoragePort();
    const before = storage.inspectNativeStorageIdentitiesAtRoot(target.brokerRoot);
    if ((await inspectIndependentDoctor(input.root)).fingerprint !== request.fingerprint) throw new Error("Doctor repair findings changed");
    await storage.repairNativeStorageIdentitiesAtRoot(target.brokerRoot, before.fingerprint);
  } else if (request.action === "retry") {
    // Fixed independent bundle only; `open` neither quits nor addresses native Codex.
    const child = spawn("/usr/bin/open", [DOCTOR_APP], { stdio: "ignore", detached: true, env: {} }); child.unref();
  } else {
    const operationId = randomUUID();
    const adapter = createSealedTweakersManagerActionAdapter({ userRoot: () => input.root });
    await approveDoctorCandidate(input.root, operationId, request.fingerprint);
    try {
      const snapshot = createTweakersManagerStatusSnapshot({ executable: input.executable, paths: managerStatusPaths(input.root), enabledActionIds: adapter.actionIds(), officialSourceVerification: "strict" });
      await adapter.prepare({ requestId: input.requestId, operationId, actionId: "refresh.independent", stateToken: snapshot.stateToken,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), parameters: {}, executable: input.executable });
      writeDoctorPrivateJson(join(doctorDirectory(input.root), "update-operation.json"), { operationId, jobId: readDoctorUpdateJob(input.root)?.id, createdAt: new Date().toISOString() });
      const child = spawn(input.executable.path, ["execute", "--request-id", randomUUID(), "--operation-id", operationId, "--json"], { detached: true, stdio: "ignore", env: {} });
      child.on("error", () => cancelDoctorCandidateApproval(input.root, operationId)); child.unref();
      // Approval binds the still-verified job. Do not mutate it before consumption.
      return { ...report, update: { ...report.update, state: "checking", phase: "updating", progress: "Installing the verified update and checking startup…" }, actions: report.actions.map(action => action.id === "update" || action.id === "scan" ? { ...action, enabled: false, blockers: ["Update has been submitted to the manager."] } : action) };
    } catch (error) { cancelDoctorCandidateApproval(input.root, operationId); throw error; }
  }
  return inspectIndependentDoctor(input.root);
}
export async function runIndependentDoctorCli(options: { json?: boolean; ui?: boolean; "scan-updates"?: boolean }): Promise<void> {
  const root = canonicalTweakersManagerRoot();
  let report = await inspectIndependentDoctor(root);
  if (options.ui || options["scan-updates"]) {
    const launcher = verifiedDoctorManagerLauncher(root);
    if (options.ui) {
      const child = spawn(launcher, ["doctor-open", "--request-id", randomUUID(), "--json"], { detached: true, stdio: "ignore", env: {} }); child.unref();
    }
    if (options["scan-updates"]) {
      const output = execFileSync(launcher, ["doctor-action", "--request-id", randomUUID(), "--json"], { encoding: "utf8", env: {}, timeout: 120_000,
        input: JSON.stringify({ schemaVersion: 1, action: "scan", fingerprint: report.fingerprint }), maxBuffer: 32 * 1024 * 1024 });
      report = JSON.parse(output) as DoctorReportV1;
    }
  }
  if (options.json) console.log(JSON.stringify(report));
  else {
    console.log(`Tweakers Doctor — independent ${report.target.version ?? "unavailable"} (${report.target.build ?? "unknown"})`);
    console.log(`App health: ${report.health.state}. Accounts broker: ${report.health.broker}.`);
    console.log(`Update: ${report.update.state.replaceAll("_", " ")}. ${report.update.progress}`);
    for (const finding of report.findings) console.log(`${finding.title}: ${finding.detail}`);
    if (report.update.handoff) console.log(report.update.handoff);
  }
  if (report.health.state === "blocked") process.exitCode = 1;
}

/** Legacy compatibility entrypoint. Runtime repair must never start update analysis. */
export function scanIndependentDoctorFromWatcher(): void {}

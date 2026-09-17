import { verifyDoctorSourceBytes } from "./doctor-validation.js";
import type { DoctorSourceEvidence } from "./doctor-evidence.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, readFileSync, mkdirSync, realpathSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTweakersVariant, verifyTweakersVariantCandidateReceipt, type TweakersVariantCandidateReceipt } from "./commands/create-variant.js";
import { cloneAppTree } from "./transaction.js";
import { doctorDigest, doctorDirectory, readDoctorPrivateJson, readDoctorUpdateJob, writeDoctorPrivateJson } from "./doctor-store.js";
import { readDoctorIndependentInputs } from "./doctor-independent.js";
import { readDoctorAdoption } from "./doctor-adoption.js";

/** Build a separate signed preview. It never consumes adoption approval or touches installed app state. */
export async function openDoctorPreview(root: string, expectedReport: string, side: "before" | "after"): Promise<void> {
  const checkJob = () => {
    const job = readDoctorUpdateJob(root), input = readDoctorIndependentInputs(root);
    if (!job || job.supersededBy || !job.sourcePath || !job.baselinePath || job.runtimeFingerprint !== input.runtimeFingerprint || job.installedIdentity !== input.installedIdentity) throw new Error("Preview inputs changed; resume the review first");
    return job;
  };
  const job = checkJob();
  const adoption = readDoctorAdoption(root, job);
  if (!adoption || adoption.report.fingerprint !== expectedReport) throw new Error("Preview report changed");
  const preview = join(doctorDirectory(root), "jobs", job.id, "previews", randomUUID());
  const home = join(preview, "home"), profile = join(home, "profile"), app = join(home, "Apps", "Tweakers.app");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const path of [profile, join(home, "Apps"), join(profile, "app-data"), join(profile, "codex-home"), join(home, "tmp")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  // File-only authentication cannot import the user's keychain-backed CLI credentials.
  writeFileSync(join(profile, "codex-home", "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: "wx" });
  const source = side === "before" ? job.baselinePath : job.sourcePath;
  if (!source) throw new Error("Retained preview source is unavailable");
  const jobRoot = join(doctorDirectory(root), "jobs", job.id);
  const evidenceRoot = existsSync(join(jobRoot, "evidence")) ? join(jobRoot, "evidence") : jobRoot;
  const evidence = readDoctorPrivateJson(join(evidenceRoot, side, "doctor-source-evidence.json")) as DoctorSourceEvidence | null;
  const checkSource = () => {
    if (!evidence || evidence.appPath !== source || evidence.fingerprint !== (side === "before" ? adoption.report.beforeFingerprint : adoption.report.afterFingerprint)
      || verifyDoctorSourceBytes(side, evidence).state !== "passed") throw new Error("Preview source bytes do not match the reviewed version");
  };
  checkSource();
  const output = join(preview, "package");
  const titlebarConfig = side === "after" && job.candidatePackage ? join(job.candidatePackage, "config.json") : join(readDoctorIndependentInputs(root).variantRoot, "config.json");
  let titlebarEnabled: boolean | undefined;
  try { const v = JSON.parse(readFileSync(titlebarConfig, "utf8")).tweaks?.["co.tweakers.titlebar-controls"]?.enabled; if (typeof v === "boolean") titlebarEnabled = v; } catch { /* Missing setting is recorded through the report gap. */ }
  await createTweakersVariant({ source, app, userRoot: profile, candidateOnly: true, output, doctorPreviewHome: home, doctorTitlebarEnabled: titlebarEnabled });
  const raw = readDoctorPrivateJson(join(output, "receipt", "TweakersCandidateReceipt.bundle", "Contents", "Resources", "variant-candidate-receipt.json")) as TweakersVariantCandidateReceipt;
  const receipt = verifyTweakersVariantCandidateReceipt(output, { expectedSigningIdentityHash: raw.signingIdentityHash, expectedTransactionId: raw.id,
    expectedPackageRoot: output, expectedObservedPackageRoot: output, expectedSource: raw.source, expectedIdentity: raw.identity });
  for (const path of [receipt.identity.userRoot, receipt.identity.appUserDataRoot, receipt.identity.codexHomeRoot, receipt.identity.accountsBrokerRoot, receipt.identity.appTarget]) {
    if (!path.startsWith(`${home}/`)) throw new Error("Preview identity is not isolated");
  }
  cloneAppTree(join(output, "Tweakers.app"), app);
  for (const name of ["runtime", "tweaks", "state.json", "config.json"]) cpSync(join(output, name), join(profile, name), { recursive: true, errorOnExist: true, force: false });
  const executable = join(app, "Contents", "MacOS", "Tweakers Electron");
  if (realpathSync(executable) !== executable || !lstatSync(executable).isFile()) throw new Error("Preview Electron executable is unavailable");
  checkSource();
  // Revalidate after build. A preview of a superseded report is never launched.
  if (checkJob().id !== job.id) throw new Error("Preview job changed");
  if (readDoctorAdoption(root)?.report.fingerprint !== expectedReport) throw new Error("Update changed while preparing the preview");
  const record = { schemaVersion: 1, side, reportFingerprint: expectedReport, source, receiptDigest: doctorDigest(receipt), app, home,
    conditions: "Empty disposable profile; no copied credentials; file-only CLI authentication; login and server rollout may differ from the installed app.",
    result: "prepared", createdAt: new Date().toISOString() };
  writeDoctorPrivateJson(join(preview, "preview.json"), record);
  // Use the verified Electron entry directly: the production launcher intentionally restores the real user's HOME.
  const child = spawn(executable, [`--user-data-dir=${receipt.identity.appUserDataRoot}`], { detached: true, stdio: "ignore", cwd: home, env: {
    HOME: home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8",
    CODEX_HOME: receipt.identity.codexHomeRoot, CODEX_SQLITE_HOME: receipt.identity.codexHomeRoot,
    CODEX_ELECTRON_USER_DATA_PATH: receipt.identity.appUserDataRoot, TWEAKERS_ACCOUNTS_BROKER_ROOT: receipt.identity.accountsBrokerRoot,
    TWEAKER_ACCOUNTS_BROKER_ROOT: receipt.identity.accountsBrokerRoot, TWEAKERS_DERIVED_VARIANT: "1", CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
  } });
  await new Promise<void>((done, reject) => { child.once("spawn", done); child.once("error", reject); });
  child.unref();
  writeDoctorPrivateJson(join(preview, "preview.json"), { ...record, result: "launched_not_observed", pid: child.pid });
}

import type { DoctorImplementationScopes } from "./doctor-implementation.js";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DoctorReportV1, DoctorFindingV1 } from "@therealityreport/tweakers-sdk";

export interface DoctorUpdateJobV1 {
  schemaVersion: 1;
  workflowVersion?: 2;
  compatibilityPolicyVersion?: 1;
  trigger?: "manual" | "available_update";
  availableUpdateBuild?: string;
  sourceOrigin?: "native" | "download";
  id: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  nativeIdentity: string;
  installedIdentity: string;
  baselineIdentity?: string;
  runtimeFingerprint: string;
  implementationScopes?: DoctorImplementationScopes;
  sourceGenerationId: string | null;
  sourceReceiptDigest: string | null;
  sourcePath: string | null;
  baselinePath: string | null;
  candidatePackage: string | null;
  candidateReceipt: unknown | null;
  candidateQuickIdentity?: string;
  reviewResultDigest?: string;
  supersededBy?: string;
  predecessorId?: string;
  resumeOnly?: boolean;
  lastCompletedResult?: DoctorReportV1["update"];
  result: DoctorReportV1["update"];
  findings: DoctorFindingV1[];
}
export function doctorDigest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
export function doctorDirectory(root: string): string { return join(root, "doctor"); }
export function readDoctorPrivateJson(path: string, options: { maxBytes?: number } = {}): unknown | null {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) throw new Error("Invalid Doctor evidence read limit");
  if (!existsSync(path)) return null;
  if (realpathSync(path) !== resolve(path)) throw new Error("Doctor evidence path is not canonical");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = fstatSync(fd);
    if (!a.isFile() || a.nlink !== 1 || a.uid !== process.getuid?.() || (a.mode & 0o077) !== 0 || a.size < 1) throw new Error("Doctor evidence is not owner-private");
    if (a.size > maxBytes) throw new Error(`Doctor evidence exceeds its ${Math.round(maxBytes / 1024 / 1024)} MiB read limit`);
    const bytes = readFileSync(fd), b = fstatSync(fd), c = lstatSync(path);
    if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.ctimeMs !== b.ctimeMs || a.mtimeMs !== b.mtimeMs
      || c.dev !== a.dev || c.ino !== a.ino || c.isSymbolicLink()) throw new Error("Doctor evidence changed during inspection");
    return JSON.parse(bytes.toString("utf8"));
  } finally { closeSync(fd); }
}
export function writeDoctorPrivateJson(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (realpathSync(dir) !== resolve(dir) || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Doctor evidence directory is unsafe");
  const tmp = join(dir, `.doctor-${randomUUID()}`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); const parent = openSync(dir, constants.O_RDONLY); try { fsyncSync(parent); } finally { closeSync(parent); } }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
export function readDoctorUpdateJob(root: string): DoctorUpdateJobV1 | null {
  const value = readDoctorPrivateJson(join(doctorDirectory(root), "update.json")) as DoctorUpdateJobV1 | null;
  if (value === null) return null;
  if ((value.resumeOnly !== undefined && typeof value.resumeOnly !== "boolean")
    || (value.workflowVersion !== undefined && value.workflowVersion !== 2)
    || (value.compatibilityPolicyVersion !== undefined && value.compatibilityPolicyVersion !== 1)
    || (value.trigger !== undefined && !["manual", "available_update"].includes(value.trigger))
    || (value.workflowVersion === 2 && !value.trigger)
    || (value.availableUpdateBuild !== undefined && !/^[0-9]+$/.test(value.availableUpdateBuild))
    || (value.sourceOrigin !== undefined && !["native", "download"].includes(value.sourceOrigin))
    || value.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(value.id) || !Number.isSafeInteger(value.pid)
    || typeof value.nativeIdentity !== "string" || typeof value.installedIdentity !== "string" || typeof value.runtimeFingerprint !== "string"
    || !value.result || !["checking", "compatible", "fixes_required", "review_required"].includes(value.result.state)
    || !Array.isArray(value.findings) || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("Doctor update evidence is invalid");
  return value;
}
export function writeDoctorUpdateJob(root: string, job: DoctorUpdateJobV1): void {
  job.updatedAt = new Date().toISOString();
  if (job.workflowVersion === 2) job.result.execution = { version: 2, trigger: job.trigger ?? "manual",
    status: job.supersededBy ? "superseded" : job.result.state === "checking" ? "running"
      : job.result.phase === "candidate_verified" ? "ready" : "action_required", recoverable: job.result.phase !== "candidate_verified" };
  writeDoctorPrivateJson(join(doctorDirectory(root), "jobs", job.id, "job.json"), job);
  writeDoctorPrivateJson(join(doctorDirectory(root), "update.json"), job);
}

/** Caller holds candidate-mutation.lock and has verified both signed receipts. */
export function recordDoctorCandidateOverride(root: string, jobId: string, before: string, after: string, overrideId: string): void {
  const packet = join(doctorDirectory(root), "jobs", jobId);
  const path = join(packet, "candidate-inputs.json");
  const inputs = readDoctorPrivateJson(path) as { version?: number; candidateReceiptFingerprint?: string; overrides?: unknown[] } | null;
  if (inputs?.version !== 1 || inputs.candidateReceiptFingerprint !== before) throw new Error("Candidate construction record changed before override publication");
  writeDoctorPrivateJson(join(packet, "candidate-inputs-history", before.replace(/^sha256:/, "") + ".json"), inputs);
  writeDoctorPrivateJson(path, { ...inputs, candidateReceiptFingerprint: after,
    overrides: [...(inputs.overrides ?? []), { before, after, overrideId }] });
}

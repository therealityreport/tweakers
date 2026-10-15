import { existsSync } from "node:fs";
import { join } from "node:path";
import { doctorDigest, readDoctorPrivateJson, writeDoctorPrivateJson } from "./doctor-store.js";
import { acquireProcessLock } from "./process-lock.js";

const UUID = /^[a-f0-9-]{36}$/;
const MAX_BYTES = 128 * 1024 * 1024;
type RecordName = "job.json" | "decisions.json" | "changes.json";
interface AdoptionHistory {
  schemaVersion: 1;
  job: { id: string; predecessorId: string | null };
  decisions: unknown | null;
  report: unknown | null;
  fingerprint: string;
}
function historyPath(root: string, id: string): string {
  if (!UUID.test(id)) throw new Error("Invalid adoption history identity");
  return join(root, "doctor", "adoption-history", `${id}.json`);
}
function readHistory(root: string, id: string): AdoptionHistory | null {
  const record = readDoctorPrivateJson(historyPath(root, id), { maxBytes: MAX_BYTES }) as AdoptionHistory | null;
  if (!record) return null;
  const { fingerprint, ...body } = record;
  if (record.schemaVersion !== 1 || record.job?.id !== id
    || (record.job.predecessorId !== null && !UUID.test(record.job.predecessorId))
    || record.decisions === undefined || record.report === undefined
    || (record.decisions !== null && record.report === null) || doctorDigest(body) !== fingerprint) {
    throw new Error("Archived adoption history is invalid; preserve existing adoption intent");
  }
  return record;
}

/** Preserve only the records needed by adoption, never app/runtime payloads. */
export function preserveDoctorAdoptionHistory(root: string, id: string): void {
  const destination = historyPath(root, id);
  const lock = acquireProcessLock(join(root, "doctor", "adoption.lock"));
  try {
    const base = join(root, "doctor", "jobs", id);
    const job = readDoctorPrivateJson(join(base, "job.json")) as { id?: string; predecessorId?: string | null } | null;
    if (!job || job.id !== id || (job.predecessorId !== undefined && job.predecessorId !== null && !UUID.test(job.predecessorId))) {
      throw new Error("Doctor job has no valid adoption continuity; local evidence retained");
    }
    const decisions = readDoctorPrivateJson(join(base, "decisions.json"));
    const report = decisions === null ? null : readDoctorPrivateJson(join(base, "changes.json"), { maxBytes: MAX_BYTES });
    if (decisions !== null && report === null) throw new Error("Historical adoption intent has missing report evidence; local evidence retained");
    const body = { schemaVersion: 1 as const, job: { id, predecessorId: job.predecessorId ?? null }, decisions, report };
    const record = { ...body, fingerprint: doctorDigest(body) };
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES) throw new Error("Adoption history exceeds the retained record limit");
    const prior = readHistory(root, id);
    if (prior && prior.fingerprint !== record.fingerprint) throw new Error("Existing adoption history differs; local evidence retained");
    if (!prior) writeDoctorPrivateJson(destination, record);
    if (readHistory(root, id)?.fingerprint !== record.fingerprint) throw new Error("Adoption history verification failed");
  } finally { lock.release(); }
}

/** A live packet remains authoritative; retired packets use sealed metadata. */
export function readDoctorAdoptionRecord(root: string, id: string, name: RecordName): unknown | null {
  historyPath(root, id);
  const base = join(root, "doctor", "jobs", id);
  const path = join(base, name);
  if (existsSync(path) || existsSync(join(base, "job.json"))) {
    return readDoctorPrivateJson(path, name === "changes.json" ? { maxBytes: MAX_BYTES } : {});
  }
  const record = readHistory(root, id);
  return record ? name === "job.json" ? record.job : name === "decisions.json" ? record.decisions : record.report : null;
}

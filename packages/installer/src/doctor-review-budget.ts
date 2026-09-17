import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { acquireProcessLock } from "./process-lock.js";
import { doctorDigest, readDoctorPrivateJson, writeDoctorPrivateJson } from "./doctor-store.js";

export const DOCTOR_REVIEW_LIMITS = { promptBytes: 32 * 1024, attemptsPerPacket: 2, evidenceExpansions: 1 } as const;
export class DoctorReviewPause extends Error {
  constructor(public readonly code: "usage_unavailable" | "no_progress", message: string) { super(message); this.name = "DoctorReviewPause"; }
}
export interface DoctorReviewRequestMetadata {
  configuredModel?: string;
  reviewerFingerprint?: string;
  configuredEffort?: string;
  stage?: string;
  evidenceFingerprint?: string;
  outputPath?: string;
  eventsPath?: string;
  questionIds?: string[];
  expansion?: boolean;
  opaqueAccountId?: string;
  executionLeaseId?: string;
  executionRequestId?: string;
  executionStatus?: "not_dispatched";
  executionSettled?: boolean;
}
interface Ledger {
  schemaVersion: 1 | 2;
  policy?: { version: 1; mode: "finish_automatically"; migratedAt: string };
  binding: string;
  extensions?: Array<{ at: string; reportFingerprint: string }>;
  requests: Array<{ id: string; promptBytes: number; usage: { inputTokens: number; outputTokens: number } | null;
    metadata?: DoctorReviewRequestMetadata; reservedAt?: string; settledAt?: string;
    actualModel?: string | null; actualEffort?: string | null; cachedInputTokens?: number | null }>;

}
function location(root: string, binding: string): string {
  const path = join(root, "budgets", `${doctorDigest(binding).slice(7)}.json`);
  return path;
}
function read(path: string, binding: string): Ledger {
  const value = readDoctorPrivateJson(path) as Ledger | null;
  if (!value) return { schemaVersion: 2, policy: { version: 1, mode: "finish_automatically", migratedAt: new Date().toISOString() }, binding, requests: [] };
  if (value.extensions !== undefined && (!Array.isArray(value.extensions) || value.extensions.some(e => !Number.isFinite(Date.parse(e.at)) || !/^sha256:[a-f0-9]{64}$/.test(e.reportFingerprint)))) throw new Error("Review allowance history is invalid");
  if (![1, 2].includes(value.schemaVersion) || value.binding !== binding || !Array.isArray(value.requests)
    || value.requests.some(r => typeof r.id !== "string" || !Number.isSafeInteger(r.promptBytes)
      || r.usage !== null && (!Number.isSafeInteger(r.usage.inputTokens) || r.usage.inputTokens < 0
        || !Number.isSafeInteger(r.usage.outputTokens) || r.usage.outputTokens < 0))) throw new Error("Review budget receipt is invalid");
  return value;
}
/** Reserve before launch. Crashes and missing usage never refund a paid request. */
export function reserveDoctorReviewRequest(root: string, binding: string, promptBytes: number, metadata?: DoctorReviewRequestMetadata): string {
  if (!Number.isSafeInteger(promptBytes) || promptBytes < 1) throw new Error("Review packet size is invalid");
  if (promptBytes > DOCTOR_REVIEW_LIMITS.promptBytes) throw new Error("Review packet exceeds 32 KiB; narrow its evidence before model review");
  const path = location(root, binding);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = acquireProcessLock(`${path}.lock`);
  try {
    const ledger = read(path, binding);
    // Explicit policy migration preserves the complete old ledger and extensions.
    ledger.schemaVersion = 2;
    ledger.policy ??= { version: 1, mode: "finish_automatically", migratedAt: new Date().toISOString() };
    writeDoctorPrivateJson(path, ledger);
    if (ledger.requests.some(r => r.usage === null)) throw new DoctorReviewPause("usage_unavailable", "Previous review usage is unavailable; recover its execution record before continuing");
    const attempts = metadata?.evidenceFingerprint ? ledger.requests.filter(r => r.metadata?.executionStatus !== "not_dispatched" && r.metadata?.evidenceFingerprint === metadata.evidenceFingerprint).length : 0;
    const exhaustedQuestion = metadata?.questionIds?.some(id => ledger.requests.filter(r => r.metadata?.executionStatus !== "not_dispatched" && r.metadata?.questionIds?.includes(id)
      && !!r.metadata?.expansion === !!metadata.expansion).length >= DOCTOR_REVIEW_LIMITS.attemptsPerPacket);
    if (attempts >= DOCTOR_REVIEW_LIMITS.attemptsPerPacket || exhaustedQuestion) throw new DoctorReviewPause("no_progress", "This evidence packet already used its initial and corrective attempts; inspect its retained result instead of repeating it");
    const id = randomUUID();
    ledger.requests.push({ id, promptBytes, usage: null, metadata, reservedAt: new Date().toISOString(), actualModel: null, actualEffort: null, cachedInputTokens: null });
    writeDoctorPrivateJson(path, ledger);
    return id;
  } finally { lock.release(); }
}

/** The caller has not invoked the provider. Keep the reservation and explicitly record that no request was dispatched. */
export function recordDoctorReviewNotDispatched(root: string, binding: string, id: string): void {
  const path = location(root, binding), lock = acquireProcessLock(`${path}.lock`);
  try {
    const ledger = read(path, binding), request = ledger.requests.find(r => r.id === id);
    if (!request || request.usage !== null) throw new Error("Review reservation cannot be cancelled");
    request.metadata = { ...request.metadata, executionStatus: "not_dispatched" };
    request.usage = { inputTokens: 0, outputTokens: 0 };
    request.settledAt = new Date().toISOString();
    writeDoctorPrivateJson(path, ledger);
  } finally { lock.release(); }
}

export function recordDoctorReviewPoolSettled(root: string, binding: string, id: string): void {
  const path = location(root, binding), lock = acquireProcessLock(`${path}.lock`);
  try {
    const ledger = read(path, binding), request = ledger.requests.find(r => r.id === id);
    if (!request?.metadata?.executionLeaseId || request.usage === null) throw new Error("Pool settlement lacks a completed execution record");
    request.metadata.executionSettled = true;
    writeDoctorPrivateJson(path, ledger);
  } finally { lock.release(); }
}
export function recordDoctorReviewUsage(root: string, binding: string, id: string, usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; model?: string; effort?: string } | null): void {
  const path = location(root, binding);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = acquireProcessLock(`${path}.lock`);
  try {
    const ledger = read(path, binding), reservation = ledger.requests.find(r => r.id === id);
    if (!reservation || reservation.usage !== null) throw new Error("Review budget reservation is missing or already settled");
    if (usage && (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0)) throw new Error("Review usage is invalid");
    if (usage?.cachedInputTokens !== undefined && (!Number.isSafeInteger(usage.cachedInputTokens) || usage.cachedInputTokens < 0 || usage.cachedInputTokens > usage.inputTokens)) throw new Error("Cached input usage is invalid");
    reservation.usage = usage === null ? null : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    reservation.settledAt = new Date().toISOString();
    reservation.actualModel = usage?.model ?? null;
    reservation.actualEffort = usage?.effort ?? null;
    reservation.cachedInputTokens = usage?.cachedInputTokens ?? null;
    writeDoctorPrivateJson(path, ledger);
  } finally { lock.release(); }
}

/** Explicit operator extension; never repairs unknown usage or refunds previous requests. */
export function extendDoctorReviewAllowance(root: string, binding: string, reportFingerprint: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(reportFingerprint)) throw new Error("Allowance extension requires the current report fingerprint");
  const path = location(root, binding);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = acquireProcessLock(`${path}.lock`);
  try {
    const ledger = read(path, binding);
    if (ledger.requests.some(r => r.usage === null)) throw new Error("Resolve missing request usage before extending the allowance");
    if (ledger.extensions?.some(e => e.reportFingerprint === reportFingerprint)) throw new Error("This allowance extension was already consumed; refresh the report");
    ledger.extensions = [...(ledger.extensions ?? []), { at: new Date().toISOString(), reportFingerprint }];
    writeDoctorPrivateJson(path, ledger);
  } finally { lock.release(); }
}
export function readDoctorReviewUsage(root: string, binding: string): Ledger {
  return read(location(root, binding), binding);
}

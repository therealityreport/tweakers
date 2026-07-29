import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { isMacOsJunkName } from "./fs-copy.js";

export const RUNTIME_FINGERPRINT_FILE = "runtime-fingerprint.json";

export interface RuntimeFingerprintDocument {
  schemaVersion: 1;
  fingerprint: string;
  generatedAt?: string;
  fileCount: number;
}

export interface RuntimeTreeFingerprint {
  fingerprint: string;
  fileCount: number;
}

export type RuntimeFingerprintRepairDecision =
  | { action: "current"; expected: string; active: string }
  | { action: "pending"; expected: string; active: string | null }
  | { action: "repair"; expected: string; active: string | null }
  | { action: "unknown"; expected: string | null; active: string | null };

/** Uses the same deterministic tree algorithm as runtime asset packaging. */
export function computeRuntimeFingerprint(runtimeRoot: string): RuntimeTreeFingerprint {
  const hash = createHash("sha256");
  let fileCount = 0;

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Junk skip must stay in lockstep with runtime/src/watcher-health.ts and
      // scripts/copy-assets.mjs — all three must produce identical fingerprints.
      if (isMacOsJunkName(entry.name)) continue;
      const path = join(directory, entry.name);
      const name = relative(runtimeRoot, path);
      if (name === RUNTIME_FINGERPRINT_FILE) continue;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        fileCount += 1;
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };

  walk(runtimeRoot);
  return { fingerprint: hash.digest("hex"), fileCount };
}

export function readRuntimeFingerprintEvidence(runtimeRoot: string): RuntimeTreeFingerprint | null {
  try {
    const value = JSON.parse(readFileSync(join(runtimeRoot, RUNTIME_FINGERPRINT_FILE), "utf8")) as Partial<RuntimeFingerprintDocument>;
    if (
      value.schemaVersion !== 1
      || typeof value.fingerprint !== "string"
      || !/^[a-f0-9]{64}$/i.test(value.fingerprint)
      || !Number.isInteger(value.fileCount)
      || Number(value.fileCount) < 0
    ) return null;
    const actual = computeRuntimeFingerprint(runtimeRoot);
    return actual.fingerprint === value.fingerprint && actual.fileCount === value.fileCount
      ? actual
      : null;
  } catch {
    return null;
  }
}

export function readRuntimeFingerprint(runtimeRoot: string): string | null {
  return readRuntimeFingerprintEvidence(runtimeRoot)?.fingerprint ?? null;
}

export function decideRuntimeFingerprintRepair(input: {
  expected: string | null;
  active: string | null;
  appRunning: boolean;
}): RuntimeFingerprintRepairDecision {
  const { expected, active, appRunning } = input;
  if (!expected) return { action: "unknown", expected, active };
  if (expected === active) return { action: "current", expected, active };
  return appRunning
    ? { action: "pending", expected, active }
    : { action: "repair", expected, active };
}

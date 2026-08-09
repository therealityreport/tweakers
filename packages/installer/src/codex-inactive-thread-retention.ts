import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const JAVASCRIPT_MODULE_EXTENSION = /\.[cm]?js$/i;
const RENDERER_ROOT = "webview";
const FINGERPRINT_WINDOW = 12_000;

const REQUIRED_NEARBY_FINGERPRINTS = [
  "inactive_thread_unsubscribe_check_scheduled",
  "inactive_thread_unsubscribed",
  "thread/unsubscribe",
  "maxInactiveOwnerThreads",
] as const;

const POLICY_PATTERN = /zjn\s*=\s*3600\s*\*\s*1e3\s*,\s*Bjn\s*=\s*15e3\s*,\s*Vjn\s*=\s*4\s*,\s*Hjn\s*=\s*class\b/g;
const PATCHED_POLICY_PATTERN = /zjn\s*=\s*60\s*\*\s*1e3\s*,\s*Bjn\s*=\s*15e3\s*,\s*Vjn\s*=\s*0\s*,\s*Hjn\s*=\s*class\b/g;

export interface CodexInactiveThreadRetentionPatch {
  source: string;
  changed: boolean;
  strategy: "already-patched" | "bounded-local-policy";
}

export interface CodexInactiveThreadRetentionAppPatch {
  status: "patched" | "already-patched" | "not-applicable";
  relativePath?: string;
  scannedFiles: number;
  strategy?: CodexInactiveThreadRetentionPatch["strategy"];
}

/**
 * Verify and bound Codex's inactive-owner retention policy without touching
 * the surrounding active, in-progress, or follower safeguards. The returned
 * source differs only in the inactive TTL and inactive-owner cache limit.
 */
export function patchCodexInactiveThreadRetentionSource(
  source: string,
): CodexInactiveThreadRetentionPatch | null {
  const originalMatches = verifiedPolicyMatches(source, POLICY_PATTERN);
  const patchedMatches = verifiedPolicyMatches(source, PATCHED_POLICY_PATTERN);
  if (originalMatches.length > 1 || patchedMatches.length > 1) {
    throw new Error("Codex inactive-thread retention policy matched multiple renderer initializers");
  }
  if (originalMatches.length === 0 && patchedMatches.length === 1) {
    return { source, changed: false, strategy: "already-patched" };
  }
  if (originalMatches.length === 1 && patchedMatches.length === 1) {
    throw new Error("Codex inactive-thread retention policy contains both original and patched initializers");
  }
  if (originalMatches.length === 1) {
    const match = originalMatches[0];
    const matchIndex = match.index ?? -1;
    if (!match[0] || matchIndex < 0) {
      throw new Error("Codex inactive-thread retention policy could not resolve its initializer");
    }
    const replacement = match[0]
      .replace(/3600(\s*\*\s*1e3)/, "60$1")
      .replace(/(Vjn\s*=\s*)4/, (_value: string, prefix: string) => `${prefix}0`);
    return {
      source: source.slice(0, matchIndex) + replacement + source.slice(matchIndex + match[0].length),
      changed: true,
      strategy: "bounded-local-policy",
    };
  }

  if (hasRetentionFingerprint(source)) {
    throw new Error(
      "Codex inactive-thread retention policy layout changed; refusing an unverified renderer change",
    );
  }
  return null;
}

/** Patch exactly one verified inactive-thread policy in an extracted app tree. */
export function patchCodexInactiveThreadRetentionInExtractedApp(
  appDir: string,
): CodexInactiveThreadRetentionAppPatch {
  const rendererRoot = resolve(appDir, RENDERER_ROOT);
  const candidates = collectJavaScriptFiles(rendererRoot);
  const inspected: Array<{
    path: string;
    source: string;
    patch: CodexInactiveThreadRetentionPatch | null;
  }> = [];

  for (const path of candidates) {
    const source = readFileSync(path, "utf8");
    try {
      inspected.push({ path, source, patch: patchCodexInactiveThreadRetentionSource(source) });
    } catch (error) {
      throw new Error(
        `Codex inactive-thread retention patch rejected ${relative(appDir, path)}: ${errorMessage(error)}`,
      );
    }
  }

  const matches = inspected.filter((candidate) => candidate.patch);
  if (matches.length === 0) return { status: "not-applicable", scannedFiles: candidates.length };
  if (matches.length > 1) {
    throw new Error(
      `Codex inactive-thread retention patch matched ${matches.length} renderer files; refusing an ambiguous renderer change`,
    );
  }

  const selected = matches[0];
  if (!selected?.patch) throw new Error("Codex inactive-thread retention patch lost its selected renderer candidate");
  if (selected.patch.changed) writeFileSync(selected.path, selected.patch.source);
  return {
    status: selected.patch.changed ? "patched" : "already-patched",
    relativePath: relative(appDir, selected.path),
    scannedFiles: candidates.length,
    strategy: selected.patch.strategy,
  };
}

function verifiedPolicyMatches(source: string, pattern: RegExp): RegExpMatchArray[] {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].filter((match) => hasNearbyFingerprints(source, match.index ?? -1));
}

function hasNearbyFingerprints(source: string, matchIndex: number): boolean {
  if (matchIndex < 0) return false;
  const window = source.slice(matchIndex, matchIndex + FINGERPRINT_WINDOW);
  return REQUIRED_NEARBY_FINGERPRINTS.every((fingerprint) => window.includes(fingerprint));
}

function hasRetentionFingerprint(source: string): boolean {
  return REQUIRED_NEARBY_FINGERPRINTS.some((fingerprint) => source.includes(fingerprint));
}

function collectJavaScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(target));
    else if (entry.isFile() && JAVASCRIPT_MODULE_EXTENSION.test(entry.name)) files.push(target);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

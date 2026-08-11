import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { RendererPatchDeclined, type RendererPatchApplication } from "./renderer-patch-outcome.js";

const JAVASCRIPT_MODULE_EXTENSION = /\.[cm]?js$/i;
const RENDERER_ROOT = "webview";

/**
 * Codex logs this event with the retention policy's own values inlined, and
 * the payload keys name the minified bindings for us:
 *
 *   ...`inactive_thread_unsubscribe_candidates_evaluated`,{safe:{...,
 *      maxInactiveOwnerThreads:Njn,overage:r,ttlMs:jjn},sensitive:{}}
 *
 * Telemetry keys are wire-visible, so the minifier renames everything around
 * them but never them. Discovering the binding names from this payload is what
 * lets the patch track a renderer rebuild instead of breaking on one: build
 * 6321 called them zjn/Vjn and build 6396 calls them jjn/Njn, and both resolve
 * through the identical anchor.
 */
const RETENTION_TELEMETRY_ANCHOR = "inactive_thread_unsubscribe_candidates_evaluated";
const TELEMETRY_PAYLOAD_WINDOW = 400;

/**
 * Marks our own edit. Detecting "already patched" by looking for the bounded
 * values instead would misread a bundle that legitimately ships them upstream.
 */
export const CODEX_INACTIVE_THREAD_RETENTION_MARKER = "__tweaker_inactive_thread_retention__";

const BOUNDED_INACTIVE_TTL_SECONDS = 60;
const BOUNDED_INACTIVE_OWNER_CACHE = 0;

const IDENTIFIER_SOURCE = "[$A-Za-z_][$A-Za-z0-9_]*";

export interface CodexInactiveThreadRetentionPatch {
  source: string;
  changed: boolean;
  strategy: "already-patched" | "telemetry-key-discovery";
  /** Upstream's own values, so a report can say what we bounded. */
  observed?: { ttlSeconds: number; ownerCache: number };
}

export interface CodexInactiveThreadRetentionAppPatch extends RendererPatchApplication {
  strategy?: CodexInactiveThreadRetentionPatch["strategy"];
}

interface RetentionBindings {
  ttlName: string;
  ownerCacheName: string;
}

interface NumericBinding {
  name: string;
  value: number;
  /** Offset of the numeric literal itself within the source. */
  valueIndex: number;
  valueText: string;
}

/**
 * Bound Codex's inactive-owner retention policy without touching the
 * surrounding active, in-progress, or follower safeguards. The returned source
 * differs only in the inactive TTL, the inactive-owner cache limit, and our
 * marker comment.
 *
 * Returns null when this file does not carry the policy at all. Throws
 * {@link RendererPatchDeclined} when the policy is present but no longer
 * legible, and a bare Error when the file contradicts itself or when our own
 * output fails re-verification.
 */
export function patchCodexInactiveThreadRetentionSource(
  source: string,
): CodexInactiveThreadRetentionPatch | null {
  const anchors = [...source.matchAll(new RegExp(escapeRegExp(RETENTION_TELEMETRY_ANCHOR), "g"))];
  if (anchors.length === 0) return null;
  if (anchors.length > 1) {
    throw new Error(
      `Codex inactive-thread retention telemetry anchor appears ${anchors.length} times; refusing an ambiguous renderer change`,
    );
  }

  const anchorIndex = anchors[0]?.index ?? -1;
  if (anchorIndex < 0) {
    throw new Error("Codex inactive-thread retention policy could not resolve its telemetry anchor");
  }

  const bindings = discoverRetentionBindings(source, anchorIndex);
  const ttl = soleTtlBinding(source, bindings.ttlName);
  const ownerCache = soleOwnerCacheBinding(source, bindings.ownerCacheName);

  const markerCount = source.split(CODEX_INACTIVE_THREAD_RETENTION_MARKER).length - 1;
  if (markerCount > 1) {
    throw new Error(
      `Codex inactive-thread retention marker appears ${markerCount} times; refusing an ambiguous renderer change`,
    );
  }
  if (markerCount === 1) {
    if (ttl.value !== BOUNDED_INACTIVE_TTL_SECONDS || ownerCache.value !== BOUNDED_INACTIVE_OWNER_CACHE) {
      throw new Error(
        "Codex inactive-thread retention marker is attached to an unbounded policy; refusing an ambiguous renderer change",
      );
    }
    return { source, changed: false, strategy: "already-patched" };
  }

  const observed = { ttlSeconds: ttl.value, ownerCache: ownerCache.value };
  const patched = rewriteBindings(source, ttl, ownerCache);

  // Re-read our own output through the same discovery path. A matcher loose
  // enough to hit the wrong site fails here rather than shipping.
  const verified = patchCodexInactiveThreadRetentionSource(patched);
  if (!verified || verified.changed || verified.strategy !== "already-patched") {
    throw new Error("Codex inactive-thread retention patch did not produce a verifiable bounded policy");
  }

  return { source: patched, changed: true, strategy: "telemetry-key-discovery", observed };
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
      const relativePath = relative(appDir, path);
      const message = `Codex inactive-thread retention patch rejected ${relativePath}: ${errorMessage(error)}`;
      // Preserve the decline so the caller can record a skip; anything else
      // still fails the build.
      if (error instanceof RendererPatchDeclined) {
        throw new RendererPatchDeclined({ message, reasonCode: error.reasonCode, relativePath });
      }
      throw new Error(message);
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
  const observed = selected.patch.observed;
  return {
    status: selected.patch.changed ? "patched" : "already-patched",
    relativePath: relative(appDir, selected.path),
    scannedFiles: candidates.length,
    strategy: selected.patch.strategy,
    ...(observed
      ? { detail: `bounded upstream ttl ${observed.ttlSeconds}s and owner cache ${observed.ownerCache}` }
      : {}),
  };
}

/**
 * Read the two binding names out of the telemetry payload. Scoped to a window
 * after the anchor on purpose — `ttlMs:` is a common enough key that a
 * file-wide scan would bind the wrong identifier.
 */
function discoverRetentionBindings(source: string, anchorIndex: number): RetentionBindings {
  const window = source.slice(anchorIndex, anchorIndex + TELEMETRY_PAYLOAD_WINDOW);
  const ttlName = new RegExp(`\\bttlMs\\s*:\\s*(${IDENTIFIER_SOURCE})`).exec(window)?.[1];
  const ownerCacheName = new RegExp(
    `\\bmaxInactiveOwnerThreads\\s*:\\s*(${IDENTIFIER_SOURCE})`,
  ).exec(window)?.[1];

  if (!ttlName || !ownerCacheName) {
    throw new RendererPatchDeclined({
      reasonCode: "layout-drift",
      message:
        "Codex inactive-thread retention telemetry payload no longer names its ttlMs and maxInactiveOwnerThreads bindings; refusing an unverified renderer change",
    });
  }
  if (ttlName === ownerCacheName) {
    throw new Error(
      `Codex inactive-thread retention telemetry payload binds ttlMs and maxInactiveOwnerThreads to the same name (${ttlName}); refusing an ambiguous renderer change`,
    );
  }
  return { ttlName, ownerCacheName };
}

/** The TTL is written as `<seconds>*1e3`; accept any integer, pin the shape. */
function soleTtlBinding(source: string, name: string): NumericBinding {
  return soleNumericBinding(source, name, /^\s*(\d+)\s*\*\s*1e3/, "ttlMs");
}

function soleOwnerCacheBinding(source: string, name: string): NumericBinding {
  return soleNumericBinding(source, name, /^\s*(\d+)(?![\d.eExX*])/, "maxInactiveOwnerThreads");
}

/**
 * Resolve a discovered binding to its single numeric assignment.
 *
 * Assignment count is checked before value shape on purpose. A name assigned
 * twice means we can no longer tell which write the policy reads — that is
 * evidence the file contradicts our model, so it fails the build. A single
 * assignment we cannot read is upstream moving on, so it declines.
 */
function soleNumericBinding(
  source: string,
  name: string,
  valuePattern: RegExp,
  label: string,
): NumericBinding {
  const assignments = [
    ...source.matchAll(new RegExp(`(?<![$A-Za-z0-9_])${escapeRegExp(name)}\\s*=(?![=>])`, "g")),
  ];
  if (assignments.length > 1) {
    throw new Error(
      `Codex inactive-thread retention ${label} binding (${name}) is assigned ${assignments.length} times; refusing an ambiguous renderer change`,
    );
  }

  const assignment = assignments[0];
  const assignmentIndex = assignment?.index ?? -1;
  if (!assignment || assignmentIndex < 0) {
    throw new RendererPatchDeclined({
      reasonCode: "layout-drift",
      message: `Codex inactive-thread retention ${label} binding (${name}) is never assigned; refusing an unverified renderer change`,
    });
  }

  const valueStart = assignmentIndex + assignment[0].length;
  const value = valuePattern.exec(source.slice(valueStart, valueStart + 64));
  const valueText = value?.[1];
  if (!value || !valueText) {
    throw new RendererPatchDeclined({
      reasonCode: "layout-drift",
      message: `Codex inactive-thread retention ${label} binding (${name}) is no longer a plain numeric assignment; refusing an unverified renderer change`,
    });
  }

  return {
    name,
    value: Number(valueText),
    valueIndex: valueStart + value[0].indexOf(valueText),
    valueText,
  };
}

/** Rewrite the two numeric literals in place, highest offset first. */
function rewriteBindings(source: string, ttl: NumericBinding, ownerCache: NumericBinding): string {
  const edits = [
    {
      index: ttl.valueIndex,
      length: ttl.valueText.length,
      text: `${BOUNDED_INACTIVE_TTL_SECONDS}`,
    },
    {
      index: ownerCache.valueIndex,
      length: ownerCache.valueText.length,
      // The marker rides the owner-cache edit so it lands exactly once.
      text: `${BOUNDED_INACTIVE_OWNER_CACHE}/*${CODEX_INACTIVE_THREAD_RETENTION_MARKER}*/`,
    },
  ].sort((left, right) => right.index - left.index);

  if (overlaps(edits[0], edits[1])) {
    throw new Error("Codex inactive-thread retention bindings resolved to overlapping edits");
  }

  let patched = source;
  for (const edit of edits) {
    patched = patched.slice(0, edit.index) + edit.text + patched.slice(edit.index + edit.length);
  }
  return patched;
}

function overlaps(
  higher: { index: number; length: number } | undefined,
  lower: { index: number; length: number } | undefined,
): boolean {
  if (!higher || !lower) return false;
  return lower.index + lower.length > higher.index;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

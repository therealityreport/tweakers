import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parse } from "acorn";
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
export const CODEX_INACTIVE_THREAD_RETENTION_MARKER = "__tweaker_inactive_thread_retention_v2__";
const LEGACY_RETENTION_MARKER = "__tweaker_inactive_thread_retention__";
const KEEP_ACTIVITY_MARKER = "__tweaker_keep_chat_activity_v2__";
const UNSUBSCRIBE_ACTIVITY_MARKER = "__tweaker_recheck_chat_activity_v2__";

export const BOUNDED_INACTIVE_TTL_SECONDS = 300;
export const BOUNDED_INACTIVE_OWNER_CACHE = 2;

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
  relativePaths?: string[];
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
 * active, in-progress, pending-input, or follower safeguards. Recheck activity
 * immediately before native unsubscribe, and keep all in-progress turns loaded.
 *
 * Returns null when this file does not carry the policy at all. Throws
 * {@link RendererPatchDeclined} when the policy is present but no longer
 * legible, and a bare Error when the file contradicts itself or when our own
 * output fails re-verification.
 */
export function patchCodexInactiveThreadRetentionSource(
  source: string,
  telemetryAnchor = RETENTION_TELEMETRY_ANCHOR,
): CodexInactiveThreadRetentionPatch | null {
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{7,160}$/.test(telemetryAnchor)) throw new Error("Invalid retention telemetry anchor");
  const anchors = [...source.matchAll(new RegExp(escapeRegExp(telemetryAnchor), "g"))];
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
  const legacyCount = source.split(LEGACY_RETENTION_MARKER).length - 1;
  if (legacyCount > 1 || (legacyCount && markerCount)) throw new Error("Conflicting retention policy markers");
  if (legacyCount && (ttl.value !== 60 || ownerCache.value !== 0 || !source.includes(`/*${LEGACY_RETENTION_MARKER}*/`))) {
    throw new Error("Legacy retention marker is attached to an unbounded policy");
  }
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
    if (patchCodexInactiveThreadActivitySource(source, telemetryAnchor).changed) {
      throw new Error("Retention policy marker lacks verified activity safeguards");
    }
    return { source, changed: false, strategy: "already-patched" };
  }

  const observed = { ttlSeconds: ttl.value, ownerCache: ownerCache.value };
  const bounded = rewriteBindings(source, ttl, ownerCache).replace(`/*${LEGACY_RETENTION_MARKER}*/`, "");
  const patched = patchCodexInactiveThreadActivitySource(bounded, telemetryAnchor).source;

  // Re-read our own output through the same discovery path. A matcher loose
  // enough to hit the wrong site fails here rather than shipping.
  const verified = patchCodexInactiveThreadRetentionSource(patched, telemetryAnchor);
  if (!verified || verified.changed || verified.strategy !== "already-patched") {
    throw new Error("Codex inactive-thread retention patch did not produce a verifiable bounded policy");
  }

  return { source: patched, changed: true, strategy: "telemetry-key-discovery", observed };
}

/** Verify every policy carrier before writing either main or renderer output. */
export function patchCodexInactiveThreadRetentionInExtractedApp(
  appDir: string,
  anchorOverrides: ReadonlyMap<string, string> = new Map(),
): CodexInactiveThreadRetentionAppPatch {
  const scopes = [RENDERER_ROOT, ".vite/build"].filter(scope => existsSync(resolve(appDir, scope)));
  const candidates = scopes.flatMap(scope => collectJavaScriptFiles(resolve(appDir, scope)));
  const inspected: Array<{
    path: string;
    source: string;
    patch: CodexInactiveThreadRetentionPatch | null;
  }> = [];

  for (const path of candidates) {
    const source = readFileSync(path, "utf8");
    try {
      inspected.push({ path, source, patch: patchCodexInactiveThreadRetentionSource(source, anchorOverrides.get(relative(appDir, path))) });
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
  for (const scope of scopes) {
    const scoped = matches.filter(candidate => relative(appDir, candidate.path).startsWith(scope + "/"));
    if (scoped.length !== 1) throw new Error(
      `Codex inactive-thread retention patch matched ${scoped.length} files in ${scope}; refusing missing or ambiguous policy coverage`,
    );
  }

  const selected = matches[0];
  if (!selected?.patch) throw new Error("Codex inactive-thread retention patch lost its selected renderer candidate");
  for (const candidate of matches) if (candidate.patch?.changed) writeFileSync(candidate.path, candidate.patch.source);
  const observed = selected.patch.observed;
  return {
    status: matches.some(candidate => candidate.patch?.changed) ? "patched" : "already-patched",
    relativePath: relative(appDir, selected.path),
    relativePaths: matches.map(candidate => relative(appDir, candidate.path)),
    scannedFiles: candidates.length,
    strategy: selected.patch.strategy,
    ...(observed
      ? { detail: `bounded upstream ttl ${observed.ttlSeconds}s and owner cache ${observed.ownerCache}; verified ${matches.length} policy carriers and activity safeguards` }
      : {}),
  };
}

type PolicyNode = { type: string; start: number; end: number; [key: string]: any };

/** Fixed native-method edits; an optional Doctor selector never supplies code. */
export function patchCodexInactiveThreadActivitySource(source: string, telemetryAnchor = RETENTION_TELEMETRY_ANCHOR): { source: string; changed: boolean } {
  const nodes: PolicyNode[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as PolicyNode;
    if (typeof node.type === "string") nodes.push(node);
    for (const [key, child] of Object.entries(node)) if (!["start", "end", "loc"].includes(key)) visit(child);
  };
  try { visit(parse(source, { ecmaVersion: "latest", sourceType: "module" })); }
  catch { throw new RendererPatchDeclined({ reasonCode: "layout-drift", message: "Native chat retention source is not valid JavaScript" }); }
  const anchorIndex = source.indexOf(telemetryAnchor);
  const carriers = nodes.filter(node => ["ClassExpression", "ClassDeclaration"].includes(node.type) && node.start < anchorIndex && node.end > anchorIndex);
  if (carriers.length !== 1) throw new RendererPatchDeclined({ reasonCode: "layout-drift", message: "Retention event does not identify one native policy class" });
  const methods = carriers[0]!.body.body as PolicyNode[];
  const method = (name: string): PolicyNode => {
    const matches = methods.filter(node => node.type === "MethodDefinition" && !node.computed && node.key.name === name);
    if (matches.length !== 1) throw new RendererPatchDeclined({ reasonCode: "layout-drift", message: `Native retention method ${name} is missing or ambiguous` });
    return matches[0]!.value;
  };
  const keep = method("shouldKeepConversationLoaded"), unsubscribe = method("unsubscribeInactiveConversation");
  const parameter = (node: PolicyNode): string => {
    if (node.params.length !== 1 || node.params[0].type !== "Identifier") throw new RendererPatchDeclined({ reasonCode: "layout-drift", message: "Native retention parameter changed" });
    return node.params[0].name;
  };
  const conversationParam = parameter(keep), idParam = parameter(unsubscribe);
  const keepReturn = keep.body.body[0] as PolicyNode;
  if (keep.body.body.length !== 1 || keepReturn?.type !== "ReturnStatement" || !keepReturn.argument) throw new RendererPatchDeclined({ reasonCode: "layout-drift", message: "Native retention activity predicate changed" });
  const comparisons = nodes.filter(node => node.start >= keepReturn.start && node.end <= keepReturn.end && node.type === "BinaryExpression" && node.operator === "===" && (node.right?.value === "inProgress" || node.right?.type === "TemplateLiteral" && node.right.expressions.length === 0 && node.right.quasis[0]?.value.cooked === "inProgress") && node.left?.type === "ChainExpression" && node.left.expression?.property?.name === "status");
  const inProgress = [...new Set(comparisons.map(node => source.slice(node.start, node.end)))];
  if (inProgress.length !== 1) throw new RendererPatchDeclined({ reasonCode: "layout-drift", message: "Native retention lacks one verifiable in-progress turn predicate" });
  const latest = unsubscribe.body.body.flatMap((node: PolicyNode) => node.type === "VariableDeclaration" ? node.declarations : []).filter((node: PolicyNode) => node.id?.type === "Identifier" && node.init?.type === "CallExpression" && source.slice(node.init.callee.start, node.init.callee.end) === "this.params.threadStore.getConversation" && node.init.arguments?.[0]?.name === idParam);
  if (latest.length !== 1) throw new RendererPatchDeclined({ reasonCode: "layout-drift", message: "Native unsubscribe lacks one latest-conversation lookup" });
  const conversationName = latest[0].id.name;
  const guards = unsubscribe.body.body.filter((node: PolicyNode) => node.type === "IfStatement" && source.slice(node.test.start, node.test.end).includes(`this.params.streamState.ownsConversationHistoryStream(${idParam})`) && source.slice(node.test.start, node.test.end).includes(`${conversationName}?.resumeState`));
  const guard = guards[0] as PolicyNode;
  const add = unsubscribe.body.body.find((node: PolicyNode) => node.type === "ExpressionStatement" && source.slice(node.start, node.end).startsWith(`this.unsubscribingConversationIds.add(${idParam})`));
  if (guards.length !== 1 || !add || latest[0].start > guard.start || guard.end > add.start || nodes.some(node => node.type === "AwaitExpression" && node.start >= unsubscribe.start && node.start < add.start)) throw new RendererPatchDeclined({ reasonCode: "layout-drift", message: "Native unsubscribe ordering or ownership guard changed" });
  const keepCount = source.split(KEEP_ACTIVITY_MARKER).length - 1, unsubscribeCount = source.split(UNSUBSCRIBE_ACTIVITY_MARKER).length - 1;
  const keepPrefix = `return/*${KEEP_ACTIVITY_MARKER}*/${conversationParam}.requests?.length>0||${inProgress[0]}||(`;
  const unsubscribeSuffix = `||this.hasActiveConversationView(${idParam})||this.hasOwnedStreamFollowers(${idParam})||this.shouldKeepConversationLoaded(${conversationName})/*${UNSUBSCRIBE_ACTIVITY_MARKER}*/)`;
  if (keepCount || unsubscribeCount) {
    const returned = source.slice(keepReturn.start, keepReturn.end);
    const head = source.slice(guard.start, guard.consequent.start).trim();
    if (keepCount !== 1 || unsubscribeCount !== 1 || !returned.startsWith(keepPrefix) || !head.endsWith(unsubscribeSuffix)) throw new Error("Native retention activity markers lack their exact guards");
    return { source, changed: false };
  }
  const edits = [
    { start: keepReturn.start, end: keepReturn.end, text: `${keepPrefix}${source.slice(keepReturn.argument.start, keepReturn.argument.end)});` },
    { start: guard.test.start, end: guard.test.end, text: `(${source.slice(guard.test.start, guard.test.end)})${unsubscribeSuffix.slice(0, -1)}` },
  ].sort((a, b) => b.start - a.start);
  let patched = source;
  for (const edit of edits) patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  const verified = patchCodexInactiveThreadActivitySource(patched, telemetryAnchor);
  if (verified.changed) throw new Error("Native retention activity guards failed verification");
  return { source: patched, changed: true };
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
  return soleNumericBinding(source, name, /^\s*(?:(\d+)\s*\*\s*1e3|(\d+(?:e[+-]?\d+)))(?![\d.])/i, "ttlMs", (match) => {
    if (match[1]) return { value: Number(match[1]), valueText: match[1] };
    const milliseconds = Number(match[2]);
    return Number.isFinite(milliseconds) && milliseconds % 1_000 === 0
      ? { value: milliseconds / 1_000, valueText: match[2]! } : null;
  });
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
  select: (match: RegExpExecArray) => { value: number; valueText: string } | null = (match) => match[1]
    ? { value: Number(match[1]), valueText: match[1] } : null,
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
  const selected = value ? select(value) : null;
  if (!value || !selected) {
    throw new RendererPatchDeclined({
      reasonCode: "layout-drift",
      message: `Codex inactive-thread retention ${label} binding (${name}) is no longer a plain numeric assignment; refusing an unverified renderer change`,
    });
  }

  return {
    name,
    value: selected.value,
    valueIndex: valueStart + value[0].indexOf(selected.valueText),
    valueText: selected.valueText,
  };
}

/** Rewrite the two numeric literals in place, highest offset first. */
function rewriteBindings(source: string, ttl: NumericBinding, ownerCache: NumericBinding): string {
  const edits = [
    {
      index: ttl.valueIndex,
      length: ttl.valueText.length,
      text: /e/i.test(ttl.valueText) ? `${BOUNDED_INACTIVE_TTL_SECONDS}*1e3` : `${BOUNDED_INACTIVE_TTL_SECONDS}`,
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

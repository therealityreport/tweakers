import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse, type Token } from "acorn";
import { CODEX_INACTIVE_THREAD_RETENTION_MARKER, patchCodexInactiveThreadRetentionSource } from "./codex-inactive-thread-retention.js";

/** Data-only adapter: the model can select evidence, never supply executable code. */
export interface DoctorPatchRepairV1 {
  version: 1;
  patchId: "inactive-thread-retention-patch";
  path: string;
  sourceSha256: string;
  telemetryAnchor: string;
}
export function validateDoctorPatchRepair(raw: unknown, source: string): DoctorPatchRepairV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Repair must be a data-only patch adapter");
  const r = raw as DoctorPatchRepairV1;
  if (Object.keys(raw).sort().join(",") !== "patchId,path,sourceSha256,telemetryAnchor,version" || r.version !== 1
    || r.patchId !== "inactive-thread-retention-patch" || typeof r.path !== "string"
    || !/^webview\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[cm]?js$/.test(r.path) || r.path.split("/").includes("..")
    || r.sourceSha256 !== `sha256:${createHash("sha256").update(source).digest("hex")}`
    || typeof r.telemetryAnchor !== "string" || !/inactive.*thread|thread.*inactive/i.test(r.telemetryAnchor) || !/^[A-Za-z_][A-Za-z0-9_.:-]{7,160}$/.test(r.telemetryAnchor)) throw new Error("Repair changed scope or its source binding");
  // Require an actual unique telemetry string, not a comment/identifier bait.
  const strings: string[] = [];
  const tokens: Array<Token & {value?: unknown}> = [];
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module", onToken: tokens });
  for (const token of tokens) if (["string", "template"].includes(token.type.label) && typeof token.value === "string") strings.push(token.value);
  if (strings.filter(value => value === r.telemetryAnchor).length !== 1) throw new Error("Repair telemetry target is missing or ambiguous");
  const expectedEdits = assertRetentionTelemetryTarget(tree, r.telemetryAnchor);
  const patched = patchCodexInactiveThreadRetentionSource(source, r.telemetryAnchor);
  if (!patched || !patched.changed || !patched.observed) throw new Error("Repair did not establish the bounded retention postcondition");
  let expected = source;
  for (const edit of expectedEdits.sort((a,b) => b.start - a.start)) expected = expected.slice(0, edit.start) + edit.text + expected.slice(edit.end);
  if (patched.source !== expected) throw new Error("Repair edits do not match the exact telemetry binding initializers");
  parse(patched.source, { ecmaVersion: "latest", sourceType: "module" });
  return { ...r };
}
export function applyDoctorPatchRepairs(directory: string, repairs: readonly DoctorPatchRepairV1[]): void {
  if (repairs.length > 1) throw new Error("Duplicate repair ownership");
  for (const repair of repairs) {
    const path = resolve(directory, repair.path);
    if (!path.startsWith(resolve(directory) + sep) || realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error("Repair target escaped the isolated candidate");
    const source = readFileSync(path, "utf8");
    validateDoctorPatchRepair(repair, source);
    writeFileSync(path, patchCodexInactiveThreadRetentionSource(source, repair.telemetryAnchor)!.source);
  }
}

/** Connect the model-selected event to one actual logging payload and its lexical bindings. */
function assertRetentionTelemetryTarget(tree: unknown, anchor: string): Array<{start: number; end: number; text: string}> {
  type Node = {type?: string; [key: string]: unknown};
  const nodes: Node[] = [];
  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const child of v) visit(child); return; }
    const n = v as Node; if (typeof n.type === "string") nodes.push(n);
    for (const [key, child] of Object.entries(n)) if (!["start", "end", "loc"].includes(key)) visit(child);
  };
  visit(tree);
  const event = (n: Node | undefined): unknown => n?.type === "Literal" ? n.value
    : n?.type === "TemplateLiteral" && (n.expressions as unknown[]).length === 0
      ? ((n.quasis as Node[])[0]?.value as {cooked?: string})?.cooked : undefined;
  const calls = nodes.filter(n => n.type === "CallExpression" && event((n.arguments as Node[])?.[0]) === anchor);
  if (calls.length !== 1) throw new Error("Repair anchor must identify exactly one telemetry invocation");
  const call = calls[0]!, callee = call.callee as Node;
  const method = callee?.property as Node;
  if (callee?.type !== "MemberExpression" || callee.computed || method.type !== "Identifier"
    || !["log", "info", "debug", "trace", "warn"].includes(String(method.name))) throw new Error("Repair anchor is not an established logging call");
  const property = (node: Node | undefined, name: string): Node | undefined => {
    if (node?.type !== "ObjectExpression") return undefined;
    const matches = (node.properties as Node[]).filter(p => p.type === "Property" && !p.computed
      && ((p.key as Node)?.name === name || (p.key as Node)?.value === name) && p.kind === "init");
    return matches.length === 1 ? matches[0]!.value as Node : undefined;
  };
  const safe = property((call.arguments as Node[])[1], "safe");
  const edits: Array<{start: number; end: number; text: string}> = [];
  for (const key of ["ttlMs", "maxInactiveOwnerThreads"]) {
    const value = property(safe, key);
    if (value?.type !== "Identifier") throw new Error("Repair telemetry payload lacks exact retention binding references");
    const declarations = nodes.filter(n => n.type === "VariableDeclarator" && (n.id as Node)?.type === "Identifier" && (n.id as Node).name === value.name);
    const shadows = nodes.filter(n => Array.isArray(n.params) && (n.params as Node[]).some(p => p.type !== "Identifier" || p.name === value.name));
    if (declarations.length !== 1 || shadows.length) throw new Error("Repair retention binding is ambiguous or shadowed");
    const binding = declarations[0]!;
    const top = (tree as Node).body as Node[];
    if (!top.some(n => n.type === "VariableDeclaration" && n.kind === "const" && (n.declarations as Node[]).includes(binding))) throw new Error("Repair retention binding must have one top-level constant definition");
    const init = binding.init as Node;
    const literal = key === "ttlMs" ? init?.left as Node : init;
    if (key === "ttlMs" && (init?.type !== "BinaryExpression" || init.operator !== "*" || (init.right as Node)?.value !== 1000)) throw new Error("Repair TTL initializer is not a seconds-to-milliseconds constant");
    if (literal?.type !== "Literal" || typeof literal.value !== "number" || !Number.isFinite(literal.value)) throw new Error("Repair retention initializer is not numeric");
    edits.push({start: Number(literal.start), end: Number(literal.end), text: key === "ttlMs" ? "60" : `0/*${CODEX_INACTIVE_THREAD_RETENTION_MARKER}*/`});
  }
  return edits;
}

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { posix, resolve, sep } from "node:path";
import type { DoctorSourceEvidence, DoctorSourceSha256 } from "./doctor-evidence.js";

export const DOCTOR_PROTOCOL_VERSION = 1;
export interface DoctorProtocolContract {
  method: string;
  direction: "client" | "server" | "notification";
  owner: string;
  consumedFields: string[];
  requestParams?: unknown;
  response?: string;
  check: string;
}
const contract = (method: string, direction: DoctorProtocolContract["direction"], owner: string, consumedFields: string[], response?: string, requestParams?: unknown): DoctorProtocolContract =>
  ({ method, direction, owner, consumedFields, ...(response ? { response } : {}), ...(requestParams !== undefined || requestParams === null ? { requestParams } : {}), check: `adapter:${method}` });
/** Interpreted interfaces, not the much larger set of pass-through methods. */
export const DOCTOR_PROTOCOL_CONTRACTS: readonly DoctorProtocolContract[] = [
  contract("initialize", "client", "App Server startup", ["capabilities", "clientInfo"], "InitializeResponse"),
  contract("threadSection/list", "client", "Thread section namespacing", ["data", "id", "name", "nextCursor"], "ThreadSectionListResponse"),
  contract("experimentalFeature/enablement/set", "client", "Feature fanout", ["enablement"], "ExperimentalFeatureEnablementSetResponse"),
  contract("thread/turns/list", "client", "Native history pagination", [
    "params.threadId", "params.cursor", "params.limit", "params.sortDirection", "params.itemsView",
    "response.data[].id", "response.data[].items[].id", "response.nextCursor",
  ], "ThreadTurnsListResponse"),
  contract("thread/items/list", "client", "Native item history", [
    "params.threadId", "params.turnId", "params.cursor", "params.limit", "params.sortDirection",
    "response.data[].turnId", "response.data[].item.id", "response.nextCursor",
  ], "ThreadItemsListResponse"),
  contract("serverRequest/resolved", "notification", "Server request correlation cleanup", ["requestId", "threadId"]),
  contract("model/list", "client", "Model selection", ["params.cursor", "response.data[].id", "response.nextCursor"], "ModelListResponse"),
  contract("account/read", "client", "Account identity", ["account", "requiresOpenaiAuth"], "GetAccountResponse"),
  contract("account/rateLimits/read", "client", "Account limits", [
    "response.rateLimits.limitId", "response.rateLimits.limitName", "response.rateLimits.rateLimitReachedType",
    "response.rateLimits.primary.usedPercent", "response.rateLimits.primary.resetsAt", "response.rateLimits.primary.windowDurationMins",
    "response.rateLimits.secondary.usedPercent", "response.rateLimits.secondary.resetsAt", "response.rateLimits.secondary.windowDurationMins",
    "response.rateLimitsByLimitId.*.limitId", "response.rateLimitsByLimitId.*.limitName", "response.rateLimitsByLimitId.*.rateLimitReachedType",
    "response.rateLimitsByLimitId.*.primary.usedPercent", "response.rateLimitsByLimitId.*.primary.resetsAt", "response.rateLimitsByLimitId.*.primary.windowDurationMins",
    "response.rateLimitsByLimitId.*.secondary.usedPercent", "response.rateLimitsByLimitId.*.secondary.resetsAt", "response.rateLimitsByLimitId.*.secondary.windowDurationMins",
    "response.rateLimitResetCredits.availableCount",
  ], "GetAccountRateLimitsResponse", null),
  contract("account/usage/read", "client", "Account usage", ["tokenUsage"], "GetAccountTokenUsageResponse"),
  contract("thread/list", "client", "Thread history and routing", [
    "params.ancestorThreadId", "params.archived", "params.cursor", "params.cwd", "params.limit", "params.modelProviders",
    "params.parentThreadId", "params.projectId", "params.searchTerm", "params.sectionId", "params.sortDirection", "params.sortKey",
    "params.sourceKinds", "params.useStateDbOnly",
    "response.data[].id", "response.data[].createdAt", "response.data[].updatedAt", "response.data[].recencyAt",
    "response.data[].projectId", "response.nextCursor",
  ], "ThreadListResponse"),
  contract("thread/search", "client", "Thread history and routing", [
    "params.archived", "params.cursor", "params.limit", "params.searchTerm", "params.sortDirection", "params.sortKey", "params.sourceKinds",
    "response.data[].thread.id", "response.data[].thread.createdAt", "response.data[].thread.updatedAt",
    "response.data[].thread.projectId", "response.nextCursor",
  ], "ThreadSearchResponse"),
  contract("thread/loaded/list", "client", "Thread history and routing", ["threadId", "thread.id", "data", "nextCursor"], "ThreadLoadedListResponse"),
  contract("thread/start", "client", "Thread history and routing", [
    "response.thread.id", "response.thread.projectId", "response.thread.turns[].id", "response.thread.turns[].items[].id",
  ], "ThreadStartResponse"),
  ...["read", "resume", "fork"].map((name) => contract(`thread/${name}`, "client", "Thread history and routing", [
    "params.threadId", "response.thread.id", "response.thread.projectId", "response.thread.turns[].id", "response.thread.turns[].items[].id",
  ], `Thread${name[0]!.toUpperCase() + name.slice(1)}Response`)),
  contract("turn/start", "client", "Turn routing", ["params.threadId", "params.model", "response.turn.id"], "TurnStartResponse"),
  contract("turn/steer", "client", "Turn routing", ["params.threadId"], "TurnSteerResponse"),
  contract("turn/interrupt", "client", "Turn routing", ["params.threadId"], "TurnInterruptResponse"),
  contract("account/chatgptAuthTokens/refresh", "server", "Account authentication", ["reason", "previousAccountId", "accessToken", "chatgptAccountId"], "ChatgptAuthTokensRefreshResponse"),
  ...[["item/commandExecution/requestApproval", "CommandExecutionRequestApprovalResponse"], ["item/fileChange/requestApproval", "FileChangeRequestApprovalResponse"], ["item/permissions/requestApproval", "PermissionsRequestApprovalResponse"], ["item/tool/requestUserInput", "ToolRequestUserInputResponse"]].map(([method, response]) => contract(method!, "server", "Approval routing", ["threadId", "turnId", "itemId"], response)),
  contract("thread/started", "notification", "Thread ownership and usage", ["params.thread.id", "params.thread.projectId", "params.thread.turns[].id", "params.thread.turns[].items[].id"]),
  ...["turn/started", "turn/completed"].map(method => contract(method, "notification", "Thread ownership and usage", ["params.threadId", "params.turn.id"])),
  ...["thread/closed", "thread/deleted", "thread/tokenUsage/updated"].map(method => contract(method, "notification", "Thread ownership and usage", ["threadId", "thread.id", "turn", "tokenUsage"])),
  contract("account/updated", "notification", "Account state", ["authMode", "rateLimits", "rateLimitsByLimitId"]),
  contract("account/rateLimits/updated", "notification", "Account state", [
    "params.rateLimits.limitId", "params.rateLimits.limitName", "params.rateLimits.rateLimitReachedType",
    "params.rateLimits.primary.usedPercent", "params.rateLimits.primary.resetsAt", "params.rateLimits.primary.windowDurationMins",
    "params.rateLimits.secondary.usedPercent", "params.rateLimits.secondary.resetsAt", "params.rateLimits.secondary.windowDurationMins",
  ]),
];
export interface DoctorProtocolCoverage {
  schemaVersion: 1;
  analysisVersion: number;
  inventoryFingerprint: DoctorSourceSha256;
  beforeFingerprint: DoctorSourceSha256;
  afterFingerprint: DoctorSourceSha256;
  interfaces: Array<DoctorProtocolContract & { status: "compatible" | "incompatible" | "unresolved"; changed: boolean; reasons: string[] }>;
  limitations: string[];
  fingerprint: DoctorSourceSha256;
}
type Schema = Record<string, unknown>;
const object = (v: unknown): v is Schema => !!v && typeof v === "object" && !Array.isArray(v);
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const digest = (v: unknown): DoctorSourceSha256 => `sha256:${createHash("sha256").update(canonical(v)).digest("hex")}`;
const annotations = new Set(["title", "description", "default", "examples", "$schema", "$id", "definitions", "$defs"]);
const understood = new Set(["type", "enum", "const", "properties", "required", "additionalProperties", "items", "anyOf", "oneOf", "allOf", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "uniqueItems", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);

class Schemas {
  readonly files = new Map<string, Schema>();
  constructor(evidence: DoctorSourceEvidence) {
    if (evidence.schemas.state !== "complete" || !evidence.schemas.root) throw new Error("Retained schema evidence unavailable");
    const root = resolve(evidence.schemas.root);
    if (realpathSync(root) !== root) throw new Error("Schema root must be canonical");
    let bytes = 0;
    for (const file of evidence.schemas.files) {
      if (!file.path.endsWith(".json")) continue;
      const path = resolve(root, file.path);
      if (!path.startsWith(root + sep) || file.kind !== "file" || realpathSync(path) !== path) throw new Error("Unsafe schema path");
      const stat = lstatSync(path);
      bytes += stat.size;
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || bytes > 64 * 1024 * 1024) throw new Error("Schema size limit exceeded");
      const raw = readFileSync(path);
      if (`sha256:${createHash("sha256").update(raw).digest("hex")}` !== file.sha256) throw new Error("Retained schema digest changed");
      const value: unknown = JSON.parse(raw.toString("utf8"));
      if (!object(value)) throw new Error("Unsupported schema document");
      this.files.set(file.path, value);
    }
  }
  expand(value: unknown, file: string, stack: string[] = [], depth = 0): unknown {
    if (depth > 80) throw new Error("Schema nesting exceeds analysis bound");
    if (typeof value === "boolean") return value;
    if (!object(value)) throw new Error("Unsupported schema value");
    if (typeof value.$ref === "string") {
      const [target, fragment = ""] = value.$ref.split("#");
      if (target?.includes(":") || (fragment && !fragment.startsWith("/"))) throw new Error("Unsupported external schema reference");
      const nextFile = target ? posix.normalize(posix.join(posix.dirname(file), target)) : file;
      const key = nextFile + "#" + fragment;
      if (stack.includes(key)) throw new Error("Recursive schema requires a dedicated compatibility check");
      let node: unknown = this.files.get(nextFile);
      for (const part of fragment.split("/").slice(1)) node = object(node) ? node[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
      if (node === undefined) throw new Error("Unresolved schema reference");
      if (Object.keys(value).some(k => k !== "$ref" && !annotations.has(k))) throw new Error("Reference siblings require a dedicated compatibility check");
      return this.expand(node, nextFile, [...stack, key], depth + 1);
    }
    const result: Schema = {};
    for (const [key, entry] of Object.entries(value)) {
      if (annotations.has(key)) continue;
      if (!understood.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
      if (key === "properties") {
        if (!object(entry)) throw new Error("Invalid schema properties");
        result[key] = Object.fromEntries(Object.entries(entry).map(([name, child]) => [name, this.expand(child, file, stack, depth + 1)]));
      } else if (["anyOf", "oneOf", "allOf"].includes(key)) {
        if (!Array.isArray(entry)) throw new Error("Invalid schema alternatives");
        result[key] = entry.map(child => this.expand(child, file, stack, depth + 1)).sort((a,b) => canonical(a).localeCompare(canonical(b)));
      } else if (key === "items" || key === "additionalProperties" && object(entry)) result[key] = this.expand(entry, file, stack, depth + 1);
      else result[key] = Array.isArray(entry) ? [...entry].sort() : entry;
    }
    return result;
  }
  message(c: DoctorProtocolContract): unknown {
    const name = c.direction === "client" ? "ClientRequest.json" : c.direction === "server" ? "ServerRequest.json" : "ServerNotification.json";
    const roots = [...this.files].filter(([path]) => path === name || path === `v2/${name}`);
    const matches: Array<{ node: unknown; file: string }> = [];
    for (const [file, root] of roots) {
      const variants = root.oneOf ?? root.anyOf;
      if (!Array.isArray(variants)) continue;
      for (const node of variants) {
        if (!object(node) || !object(node.properties) || !object(node.properties.method)) continue;
        const method = node.properties.method;
        if (method.const === c.method || Array.isArray(method.enum) && method.enum.includes(c.method)) matches.push({ node: node.properties.params ?? {}, file });
      }
    }
    if (matches.length !== 1) throw new Error(`${c.method}: missing or ambiguous method schema`);
    const params = this.expand(matches[0]!.node, matches[0]!.file);
    if (!c.response) return { params };
    const responseFiles = [...this.files.keys()].filter(path => path === `${c.response}.json` || path === `v2/${c.response}.json` || c.method === "initialize" && path === `v1/${c.response}.json`);
    if (responseFiles.length !== 1) throw new Error(`${c.method}: missing or ambiguous response schema`);
    return { params, response: this.expand(this.files.get(responseFiles[0]!), responseFiles[0]!) };
  }
}
/** Conservative structural comparison: optional additions are harmless; unknown constructs never pass. */
export function compareDoctorProtocolShapes(before: unknown, after: unknown, path = "message"): string[] {
  if (canonical(before) === canonical(after)) return [];
  if (!object(before) || !object(after)) return [`${path}: changed schema`];
  const reasons: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "properties") {
      const a = before[key] ?? {}, b = after[key] ?? {};
      if (!object(a) || !object(b)) { reasons.push(`${path}: changed object properties`); continue; }
      for (const name of Object.keys(a)) {
        if (!(name in b)) reasons.push(`${path}.${name}: removed field`);
        else reasons.push(...compareDoctorProtocolShapes(a[name], b[name], `${path}.${name}`));
      }
    } else if (key === "required") {
      const a = before[key] ?? [], b = after[key] ?? [];
      if (!Array.isArray(a) || !Array.isArray(b)) reasons.push(`${path}: invalid required fields`);
      else {
        for (const name of b) if (!a.includes(name)) reasons.push(`${path}.${name}: newly required field`);
        // Response guarantees disappearing can break consumers even if the field remains optional.
        if (path.startsWith("response")) for (const name of a) if (!b.includes(name)) reasons.push(`${path}.${name}: no longer guaranteed`);
      }
    } else if (canonical(before[key]) !== canonical(after[key])) reasons.push(`${path}: changed ${key}`);
  }
  return reasons;
}

function schemaBranches(value: unknown): Schema[] {
  if (!object(value)) return [];
  const branches = [value];
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const alternatives = value[key];
    if (Array.isArray(alternatives)) for (const alternative of alternatives) branches.push(...schemaBranches(alternative));
  }
  return branches;
}

function consumedSchemaViews(message: unknown, path: string): unknown[] {
  let nodes: Array<{schema: unknown; required: boolean[]}> = [{schema: message, required: []}];
  for (const rawSegment of path.split(".")) {
    const array = rawSegment.endsWith("[]");
    const segment = array ? rawSegment.slice(0, -2) : rawSegment;
    const next: Array<{schema: unknown; required: boolean[]}> = [];
    for (const current of nodes) for (const node of schemaBranches(current.schema)) {
      if (segment === "*") {
        if (object(node) && object(node.additionalProperties)) next.push({schema: node.additionalProperties, required: current.required});
      } else if (object(node) && object(node.properties) && node.properties[segment] !== undefined) {
        next.push({schema: node.properties[segment], required: [...current.required, Array.isArray(node.required) && node.required.includes(segment)]});
      }
    }
    nodes = array
      ? next.flatMap(current => schemaBranches(current.schema).flatMap(node => object(node) && node.items !== undefined ? [{schema: node.items, required: current.required}] : []))
      : next;
    if (nodes.length === 0) break;
  }
  return nodes.map(node => canonical(node)).sort().filter((entry, index, entries) => index === 0 || entry !== entries[index - 1]);
}

export function compareConsumedDoctorProtocolFields(before: unknown, after: unknown, fields: readonly string[]): string[] {
  const reasons: string[] = [];
  for (const field of fields) {
    const oldViews = consumedSchemaViews(before, field);
    const nextViews = consumedSchemaViews(after, field);
    if (oldViews.length === 0) {
      reasons.push(`${field}: consumed contract path is absent from the baseline schema`);
      continue;
    }
    if (nextViews.length === 0) reasons.push(`${field}: removed consumed field`);
    else if (canonical(oldViews) !== canonical(nextViews)) reasons.push(`${field}: changed consumed field schema`);
  }
  return reasons;
}

function schemaAcceptsLiteral(schema: unknown, value: unknown, depth = 0): boolean {
  if (depth > 80 || !object(schema)) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every(item => schemaAcceptsLiteral(item, value, depth + 1))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(item => schemaAcceptsLiteral(item, value, depth + 1))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(item => schemaAcceptsLiteral(item, value, depth + 1)).length !== 1) return false;
  if (schema.const !== undefined && canonical(schema.const) !== canonical(value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => canonical(item) === canonical(value))) return false;
  const types = Array.isArray(schema.type) ? schema.type : typeof schema.type === "string" ? [schema.type] : [];
  if (types.length > 0) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) return false;
  }
  if (value !== null && object(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some(name => typeof name === "string" && !(name in value))) return false;
    if (object(schema.properties)) {
      for (const [name, child] of Object.entries(value)) {
        const property = schema.properties[name];
        if (property !== undefined) {
          if (!schemaAcceptsLiteral(property, child, depth + 1)) return false;
        } else if (schema.additionalProperties === false) return false;
        else if (object(schema.additionalProperties) && !schemaAcceptsLiteral(schema.additionalProperties, child, depth + 1)) return false;
      }
    }
  }
  return true;
}

export function collectDoctorProtocolCoverage(before: DoctorSourceEvidence, after: DoctorSourceEvidence): DoctorProtocolCoverage {
  let a: Schemas | undefined, b: Schemas | undefined, problem: string | null = null;
  try { a = new Schemas(before); b = new Schemas(after); } catch (e) { problem = e instanceof Error ? e.message : String(e); }
  const interfaces = DOCTOR_PROTOCOL_CONTRACTS.map(c => {
    if (problem) return { ...c, status: "unresolved" as const, changed: true, reasons: [problem] };
    try {
      const old = a!.message(c) as { params: unknown; response?: unknown }, next = b!.message(c) as typeof old;
      const scopedFields = c.consumedFields.length > 0 && c.consumedFields.every(field => field.startsWith("params.") || field.startsWith("response."));
      const reasons = scopedFields
        ? compareConsumedDoctorProtocolFields({properties: {params: old.params, response: old.response}}, {properties: {params: next.params, response: next.response}}, c.consumedFields)
        : [...compareDoctorProtocolShapes(old.params, next.params, c.direction === "client" ? "params" : "response.params"), ...(c.response ? compareDoctorProtocolShapes(old.response, next.response, c.direction === "server" ? "params.response" : "response") : [])];
      if (Object.prototype.hasOwnProperty.call(c, "requestParams") && !schemaAcceptsLiteral(next.params, c.requestParams)) {
        reasons.push("params: production adapter request shape is not accepted");
      }
      return { ...c, status: reasons.length ? "incompatible" as const : "compatible" as const, changed: canonical(old) !== canonical(next), reasons };
    } catch (e) { return { ...c, status: "unresolved" as const, changed: true, reasons: [e instanceof Error ? e.message : String(e)] }; }
  });
  const payload = { schemaVersion: 1 as const, analysisVersion: DOCTOR_PROTOCOL_VERSION, inventoryFingerprint: digest(DOCTOR_PROTOCOL_CONTRACTS), beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint, interfaces,
    limitations: ["Schema compatibility is not backend behavior proof.", "Pass-through methods are excluded; adapter checks cover routing and correlation, not authenticated account or approval execution."] };
  return { ...payload, fingerprint: digest(payload) };
}

/** Reviewed native fallback continuity, never a general account/read relaxation.
 * Both upstream bundles use identical workspace discovery and legacy routing
 * guards. The exact retained backend and transformed candidate are pinned too.
 * Restricted/FedRAMP accounts remain rejected by the native guard in both builds;
 * this establishes unchanged behavior, not authenticated account readiness.
 */
export const REVIEWED_WORKSPACE_ROUTING_CONTINUITY = {
  beforeAsar: "sha256:1f7939c1c781887c167043c4d1d307af3400d324685cfc315dfe2f80e634f483",
  afterAsar: "sha256:13a55e6ea7808380b78415bce7319fbc895ec15b3a82afdf60d14ff956c6187c",
  backend: "sha256:16761d7460d94ae7c42da486ae47684d02cd8ab3746cca28a28375c3a8aa9cd2",
  candidateAsar: "sha256:1a476e7586e1e66112c3cf22977c014e0b4d315aa748125cf1d4ac5848228ce0",
} as const;

/** 10954 preserves the 10640 discovery guards, semver bounds and FedRAMP
 * rejection. Pin the complete upstream plus the unchanged routing carrier in
 * the constructed candidate; unrelated candidate transforms may change ASAR.
 */
export const REVIEWED_WORKSPACE_ROUTING_10954 = {
  beforeAsar: "sha256:13a55e6ea7808380b78415bce7319fbc895ec15b3a82afdf60d14ff956c6187c",
  afterAsar: "sha256:03108a728bdb1616958ab89587c5495cab0cf4cd1bbe109bdfb186df0a113804",
  routingPath: ".vite/build/src-DldfpmrL.js",
  routingSha256: "sha256:88ec69722b5d87a7081edf2e2d6a2e21c3f25300cee587363d74b8b87969a412",
} as const;

/** Reviewed 20156 callers use the actual backend version to gate item anchors
 * (>=0.159.0-alpha.2) and gateway OAuth (>=0.157.0-alpha.11). The native
 * workspace fallback retains its residency, network and FedRAMP rejection.
 * Response plan enums are widened; every old producer value remains accepted.
 * The optional initialize field additionally requires an isolated live probe.
 */
export const REVIEWED_RETAINED_BACKEND_20156 = {
  upstreamAsar: "sha256:75e397e2280dde93b70a85aa926f4282c728eacc84dfeb15ba7fb6ddd84628af",
  upstreamSchemas: "sha256:6c856caa62d9f47994b663f73802f1036c9452dc67cde0a72d8f8785f1716dd7",
  retainedSchemas: "sha256:7e6eddf50a60ead52ed8a0ae924a4ad5b8980b0ee4455bf650a5b0435dab08b9",
  backend: REVIEWED_WORKSPACE_ROUTING_CONTINUITY.backend,
  routingPath: ".vite/build/src-BJv5Mk7n.js",
  routingSha256: "sha256:72e2b366d574206f76fc079c79b64c31ce378970a797475ded8709908d338f08",
  rendererPath: "webview/assets/app-shared-8bd9d0399038.js",
  rendererSha256: "sha256:607ad0866dd25ed3764711b4467a9b60708353a599485b5249ff4cbe0e870245",
  // Exact deterministic inactive-thread retention transform; caller gates stay unchanged.
  candidateRendererSha256: "sha256:928fe2c0b0bf44bb1059369088eea7927207979d29ff43df87f31cf8def449ed",
  // Exact emitted 20156 Accounts hooks plus the earlier retention transform.
  candidateAccountsRoutingSha256: "sha256:1d40c06f47d04fde1d3236a79ec94767165b59ace5dd455f3939844017affd1c",
  candidateAccountsRendererSha256: "sha256:90d6a0fa26c0dae80b2bb23590a40edb27a3ab37cb5d0c3f62b903ba3a4bb4c0",
  // The sealed Manager's esbuild representation serializes the same reviewed
  // hook factories differently from the standalone compiled modules.
  candidateSealedAccountsRoutingSha256: "sha256:619867ad32edd6e0a2e53cdf10b9acdc545f1b85fe71ef50052aa91bb3cfa43b",
  candidateSealedAccountsRendererSha256: "sha256:edb4490902627e50d5b2e1173d27d9245d92aa33a7a4ccb3aec3e30413e03389",
  // Exact retention-v2 transform in both native carriers. Each final Accounts
  // representation is derived from these reviewed bytes in installation order.
  candidateRetentionV2RoutingSha256: "sha256:67b7c9adcc9e604dcd464334e018291a087a7cefa2a0443264874c7256910a4a",
  candidateRetentionV2RendererSha256: "sha256:42162d3da2a6a07d3006d062c905c7a679c2908b08ffce22f2a3b8b8f4f90f83",
  candidateAccountsRetentionV2RoutingSha256: "sha256:3ac6b35a9ac39358dece8ce8201e45604c56bce85edab918a8dd3b3bf87971f2",
  candidateAccountsRetentionV2RendererSha256: "sha256:7e2d4d9fe6b8b5a8fb064ca5a25a634ed3305ceda615ee4a14fdd9e16bd0083f",
  candidateSealedAccountsRetentionV2RoutingSha256: "sha256:d245d27b1c5a2c553ebc6abed8b9586c62ee373961e02b33f6ce398dbf2ea0bf",
  candidateSealedAccountsRetentionV2RendererSha256: "sha256:8e90f9a3b162c49170bc413c4bef98fcc86b509b19e95721478456293e3515ae",
} as const;

export function matchesReviewedRetainedBackend20156(upstream: DoctorSourceEvidence, retained: DoctorSourceEvidence, candidate: boolean): boolean {
  const profile = REVIEWED_RETAINED_BACKEND_20156;
  const schemas = (evidence: DoctorSourceEvidence, expected: string) => evidence.schemas.state === "complete"
    && evidence.schemas.fingerprint === expected && digest(evidence.schemas.files) === expected;
  const member = (evidence: DoctorSourceEvidence, path: string, hashes: readonly string[]) => {
    const found = evidence.asar.members.filter(item => item.path === path);
    return found.length === 1 && found[0]!.kind === "file" && !found[0]!.unpacked && hashes.includes(found[0]!.rawSha256);
  };
  return upstream.build === "20156" && upstream.version === "26.1007.30912" && upstream.asar.sha256 === profile.upstreamAsar
    && schemas(upstream, profile.upstreamSchemas) && schemas(retained, profile.retainedSchemas)
    && retained.backend.sha256 === profile.backend && retained.backend.version === "0.153.4"
    && member(upstream, profile.routingPath, [profile.routingSha256])
    && member(upstream, profile.rendererPath, [profile.rendererSha256])
    && (!candidate || retained.build === upstream.build && retained.version === upstream.version
      && member(retained, profile.routingPath, [profile.routingSha256, profile.candidateAccountsRoutingSha256, profile.candidateSealedAccountsRoutingSha256,
        profile.candidateRetentionV2RoutingSha256, profile.candidateAccountsRetentionV2RoutingSha256, profile.candidateSealedAccountsRetentionV2RoutingSha256])
      && member(retained, profile.rendererPath, [profile.rendererSha256, profile.candidateRendererSha256, profile.candidateAccountsRendererSha256, profile.candidateSealedAccountsRendererSha256,
        profile.candidateRetentionV2RendererSha256, profile.candidateAccountsRetentionV2RendererSha256, profile.candidateSealedAccountsRetentionV2RendererSha256]));
}

/** Call only after exact bytes/binding checks and the real initialization probe. */
export function applyReviewedRetainedBackend20156(coverage: DoctorProtocolCoverage, upstream: DoctorSourceEvidence,
  retained: DoctorSourceEvidence, candidate: boolean, initializePassed: boolean): DoctorProtocolCoverage {
  if (!initializePassed || !matchesReviewedRetainedBackend20156(upstream, retained, candidate)
    || coverage.beforeFingerprint !== upstream.fingerprint || coverage.afterFingerprint !== retained.fingerprint) return coverage;
  const expected: Record<string, string[]> = {
    initialize: ["params.capabilities: changed anyOf"],
    "thread/items/list": ["params.cursor: changed consumed field schema"],
    "account/read": ["response.account: changed anyOf", "response.workspaceRouting: removed field"],
    "account/updated": ["response.params.planType: changed anyOf"],
  };
  if (Object.entries(expected).some(([method, reasons]) => {
    const found = coverage.interfaces.filter(item => item.method === method);
    return found.length !== 1 || found[0]!.status !== "incompatible" || canonical([...found[0]!.reasons].sort()) !== canonical([...reasons].sort());
  })) return coverage;
  const { fingerprint: _, ...payload } = coverage;
  const updated = { ...payload, interfaces: coverage.interfaces.map(item => !expected[item.method] ? item : { ...item,
    status: "compatible" as const, reasons: ["Exact reviewed 20156 callers retain the unspoofed 0.153.4 version gates and guarded legacy workspace path; isolated initialization accepted the new optional capability."] }),
    limitations: [...coverage.limitations, "This profile preserves legacy behavior; it does not add item anchors, gateway OAuth, restricted accounts or FedRAMP support. Authenticated acceptance remains required."] };
  return { ...updated, fingerprint: digest(updated) };
}

/** Call only after source-byte and evidence-binding verification. */
export function applyReviewedWorkspaceRoutingContinuity(coverage: DoctorProtocolCoverage, previous: DoctorSourceEvidence,
  upstream: DoctorSourceEvidence, retained: DoctorSourceEvidence, candidate: boolean): DoctorProtocolCoverage {
  const reviewed = REVIEWED_WORKSPACE_ROUTING_CONTINUITY;
  const account = coverage.interfaces.find(item => item.method === "account/read");
  const current = REVIEWED_WORKSPACE_ROUTING_10954;
  const matchesRoutingCarrier = (evidence: DoctorSourceEvidence) => {
    const matches = evidence.asar.members?.filter(member => member.path === current.routingPath);
    return matches?.length === 1 && matches[0]!.kind === "file" && matches[0]!.unpacked === false
      && matches[0]!.rawSha256 === current.routingSha256;
  };
  const legacyPair = previous.asar.sha256 === reviewed.beforeAsar && upstream.asar.sha256 === reviewed.afterAsar
    && (!candidate || retained.asar.sha256 === reviewed.candidateAsar);
  const currentPair = previous.asar.sha256 === current.beforeAsar && upstream.asar.sha256 === current.afterAsar
    && matchesRoutingCarrier(upstream) && (!candidate || matchesRoutingCarrier(retained));
  if ((!legacyPair && !currentPair)
    || retained.backend.sha256 !== reviewed.backend || retained.backend.version !== "0.153.4"
    || coverage.beforeFingerprint !== upstream.fingerprint || coverage.afterFingerprint !== retained.fingerprint
    || account?.status !== "incompatible" || account.reasons.length !== 1
    || account.reasons[0] !== "response.workspaceRouting: removed field") return coverage;
  const {fingerprint: _, ...payload} = coverage;
  const updated = {...payload, interfaces: coverage.interfaces.map(item => item !== account ? item : {...item,
    status: "compatible" as const, reasons: ["Exact reviewed native workspace-routing fallback is unchanged for the retained 0.153.4 backend; native restriction and account guards remain enforced."]}),
    limitations: [...coverage.limitations, "The reviewed legacy workspace-routing path still requires installed account acceptance; it does not add support for restricted or FedRAMP accounts."]};
  return {...updated, fingerprint: digest(updated)};
}

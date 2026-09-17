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
  response?: string;
  check: string;
}
const contract = (method: string, direction: DoctorProtocolContract["direction"], owner: string, consumedFields: string[], response?: string): DoctorProtocolContract =>
  ({ method, direction, owner, consumedFields, ...(response ? { response } : {}), check: `adapter:${method}` });
/** Interpreted interfaces, not the much larger set of pass-through methods. */
export const DOCTOR_PROTOCOL_CONTRACTS: readonly DoctorProtocolContract[] = [
  contract("initialize", "client", "App Server startup", ["capabilities", "clientInfo"], "InitializeResponse"),
  contract("threadSection/list", "client", "Thread section namespacing", ["data", "id", "name", "nextCursor"], "ThreadSectionListResponse"),
  contract("experimentalFeature/enablement/set", "client", "Feature fanout", ["featureName", "enabled"], "ExperimentalFeatureEnablementSetResponse"),
  contract("thread/turns/list", "client", "Native history pagination", ["threadId", "data", "nextCursor"], "ThreadTurnsListResponse"),
  contract("thread/items/list", "client", "Native item history", ["threadId", "turnId", "data", "nextCursor"], "ThreadItemsListResponse"),
  contract("serverRequest/resolved", "notification", "Server request correlation cleanup", ["requestId", "threadId"]),
  contract("model/list", "client", "Model selection", ["data", "nextCursor"], "ModelListResponse"),
  contract("account/read", "client", "Account identity", ["account", "requiresOpenaiAuth"], "GetAccountResponse"),
  contract("account/rateLimits/read", "client", "Account limits", ["rateLimits", "rateLimitsByLimitId"], "GetAccountRateLimitsResponse"),
  contract("account/usage/read", "client", "Account usage", ["tokenUsage"], "GetAccountTokenUsageResponse"),
  ...["list", "search", "loaded/list", "read", "start", "resume", "fork"].map((name) => contract(`thread/${name}`, "client", "Thread history and routing", ["threadId", "thread.id", "data", "nextCursor"], `Thread${name.split("/").map(part => part[0]!.toUpperCase() + part.slice(1)).join("")}Response`)),
  ...["start", "steer", "interrupt"].map(name => contract(`turn/${name}`, "client", "Turn routing", ["threadId", "turnId"], `Turn${name[0]!.toUpperCase() + name.slice(1)}Response`)),
  contract("account/chatgptAuthTokens/refresh", "server", "Account authentication", ["reason", "previousAccountId", "accessToken", "chatgptAccountId"], "ChatgptAuthTokensRefreshResponse"),
  ...[["item/commandExecution/requestApproval", "CommandExecutionRequestApprovalResponse"], ["item/fileChange/requestApproval", "FileChangeRequestApprovalResponse"], ["item/permissions/requestApproval", "PermissionsRequestApprovalResponse"], ["item/tool/requestUserInput", "ToolRequestUserInputResponse"]].map(([method, response]) => contract(method!, "server", "Approval routing", ["threadId", "turnId", "itemId"], response)),
  ...["thread/started", "thread/closed", "thread/deleted", "turn/started", "turn/completed", "thread/tokenUsage/updated"].map(method => contract(method, "notification", "Thread ownership and usage", ["threadId", "thread.id", "turn", "tokenUsage"])),
  ...["account/updated", "account/rateLimits/updated"].map(method => contract(method, "notification", "Account state", ["authMode", "rateLimits", "rateLimitsByLimitId"])),
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
export function collectDoctorProtocolCoverage(before: DoctorSourceEvidence, after: DoctorSourceEvidence): DoctorProtocolCoverage {
  let a: Schemas | undefined, b: Schemas | undefined, problem: string | null = null;
  try { a = new Schemas(before); b = new Schemas(after); } catch (e) { problem = e instanceof Error ? e.message : String(e); }
  const interfaces = DOCTOR_PROTOCOL_CONTRACTS.map(c => {
    if (problem) return { ...c, status: "unresolved" as const, changed: true, reasons: [problem] };
    try {
      const old = a!.message(c) as { params: unknown; response?: unknown }, next = b!.message(c) as typeof old;
      const reasons = [...compareDoctorProtocolShapes(old.params, next.params, c.direction === "client" ? "params" : "response.params"), ...(c.response ? compareDoctorProtocolShapes(old.response, next.response, c.direction === "server" ? "params.response" : "response") : [])];
      return { ...c, status: reasons.length ? "incompatible" as const : "compatible" as const, changed: canonical(old) !== canonical(next), reasons };
    } catch (e) { return { ...c, status: "unresolved" as const, changed: true, reasons: [e instanceof Error ? e.message : String(e)] }; }
  });
  const payload = { schemaVersion: 1 as const, analysisVersion: DOCTOR_PROTOCOL_VERSION, inventoryFingerprint: digest(DOCTOR_PROTOCOL_CONTRACTS), beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint, interfaces,
    limitations: ["Schema compatibility is not backend behavior proof.", "Pass-through methods are excluded; adapter checks cover routing and correlation, not authenticated account or approval execution."] };
  return { ...payload, fingerprint: digest(payload) };
}

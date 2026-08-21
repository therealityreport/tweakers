import {
  type CorrelationDirection,
  type CorrelationRecord,
  type DispatchState,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type OpaqueAccountId,
  isJsonRpcId,
  isOpaqueAccountId,
  isPlainRecord,
} from "./types";

export type ClientRoute =
  | "fanout_initialize_intersection"
  | "balance_new_thread"
  | "fanout_aggregate_read_with_router_cursor"
  | "fanout_aggregate_namespaced_sections"
  | "persisted_thread_owner"
  | "thread_owner_if_present_else_primary"
  | "reject_in_balanced_mode_use_manual_enrollment"
  | "primary_to_desktop_internal_per_home_probe"
  | "primary_only_explicit_account_action"
  | "primary_only_then_invalidate_capability_fingerprints"
  | "host_primary_only_collision_scoped"
  | "primary_if_no_thread_then_revalidate_capabilities"
  | "primary_only_section_mutation"
  | "primary_only_fail_if_semantics_require_account_or_thread_inference"
  | "unknown";

export type ServerNotificationRoute =
  | "verify_persisted_owner_then_forward"
  | "ingest_per_home_primary_forward_only_redacted_control_projection"
  | "primary_forward_or_origin_correlation_only"
  | "unknown";

// This is the exact current experimental method inventory frozen by T1.  The
// router intentionally has no prefix-based fallback: a future method must be
// classified by a fresh contract before it can leave the desktop process.
const CLIENT_METHODS = new Set<string>([
  "account/login/cancel", "account/login/start", "account/logout", "account/rateLimitResetCredit/consume",
  "account/rateLimits/read", "account/read", "account/sendAddCreditsNudgeEmail", "account/usage/read",
  "account/workspaceMessages/read", "app/installed", "app/list", "app/read", "collaborationMode/list",
  "command/exec", "command/exec/resize", "command/exec/terminate", "command/exec/write", "config/batchWrite",
  "config/mcpServer/reload", "config/read", "config/value/write", "configRequirements/read", "environment/add",
  "environment/info", "environment/status", "experimentalFeature/enablement/set", "experimentalFeature/list",
  "externalAgentConfig/detect", "externalAgentConfig/import", "externalAgentConfig/import/readHistories",
  "externalAgentConfig/import/recordHistory", "feedback/upload", "fs/copy", "fs/createDirectory", "fs/getMetadata",
  "fs/readDirectory", "fs/readFile", "fs/remove", "fs/unwatch", "fs/watch", "fs/writeFile", "fuzzyFileSearch",
  "fuzzyFileSearch/sessionStart", "fuzzyFileSearch/sessionStop", "fuzzyFileSearch/sessionUpdate", "hooks/list", "initialize",
  "marketplace/add", "marketplace/remove", "marketplace/upgrade", "mcpServer/oauth/login", "mcpServer/resource/read",
  "mcpServer/tool/call", "mcpServerStatus/list", "memory/reset", "mock/experimentalMethod", "model/list",
  "modelProvider/capabilities/read", "permissionProfile/list", "plugin/install", "plugin/installed", "plugin/list",
  "plugin/read", "plugin/search", "plugin/share/checkout", "plugin/share/delete", "plugin/share/list", "plugin/share/save",
  "plugin/share/updateTargets", "plugin/skill/read", "plugin/uninstall", "process/kill", "process/resizePty", "process/spawn",
  "process/writeStdin", "remoteControl/client/list", "remoteControl/client/revoke", "remoteControl/disable", "remoteControl/enable",
  "remoteControl/pairing/start", "remoteControl/pairing/status", "remoteControl/status/read", "review/start", "server/diagnostics",
  "skills/config/write", "skills/extraRoots/set", "skills/list", "thread/approveGuardianDeniedAction", "thread/archive",
  "thread/backgroundTerminals/clean", "thread/backgroundTerminals/list", "thread/backgroundTerminals/terminate", "thread/compact/start",
  "thread/decrement_elicitation", "thread/delete", "thread/fork", "thread/goal/clear", "thread/goal/get", "thread/goal/set",
  "thread/increment_elicitation", "thread/inject_items", "thread/items/list", "thread/list", "thread/loaded/list",
  "thread/memoryMode/set", "thread/metadata/update", "thread/name/set", "thread/queue/add", "thread/queue/delete",
  "thread/queue/list", "thread/queue/reorder", "thread/queue/start", "thread/queue/update", "thread/read",
  "thread/realtime/appendAudio", "thread/realtime/appendSpeech", "thread/realtime/appendText", "thread/realtime/listVoices",
  "thread/realtime/start", "thread/realtime/stop", "thread/resume", "thread/revert", "thread/rollback", "thread/search",
  "thread/searchOccurrences", "thread/section/move", "thread/settings/update", "thread/shellCommand", "thread/start",
  "thread/turns/list", "thread/unarchive", "thread/unsubscribe", "threadSection/create", "threadSection/delete",
  "threadSection/list", "threadSection/update", "turn/interrupt", "turn/start", "turn/steer", "windowsSandbox/readiness", "windowsSandbox/setupStart",
]);

const SERVER_REQUEST_METHODS = new Set<string>([
  "account/chatgptAuthTokens/refresh", "applyPatchApproval", "attestation/generate", "currentTime/read",
  "execCommandApproval", "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "item/tool/call", "item/tool/requestUserInput", "mcpServer/elicitation/request",
]);

const SERVER_NOTIFICATION_METHODS = new Set<string>([
  "account/login/completed", "account/rateLimits/updated", "account/updated", "app/list/updated", "command/exec/outputDelta",
  "configWarning", "deprecationNotice", "error", "externalAgentConfig/import/completed", "externalAgentConfig/import/progress",
  "fs/changed", "fuzzyFileSearch/sessionCompleted", "fuzzyFileSearch/sessionUpdated", "guardianWarning", "hook/completed",
  "hook/started", "item/agentMessage/delta", "item/autoApprovalReview/completed", "item/autoApprovalReview/started",
  "item/commandExecution/outputDelta", "item/commandExecution/terminalInteraction", "item/completed", "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated", "item/mcpToolCall/progress", "item/plan/delta", "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/started", "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated", "model/rerouted", "model/safetyBuffering/updated", "model/verification", "process/exited",
  "process/outputDelta", "remoteControl/status/changed", "serverRequest/resolved", "skills/changed", "thread/archived",
  "thread/closed", "thread/compacted", "thread/deleted", "thread/environment/connected", "thread/environment/disconnected",
  "thread/goal/cleared", "thread/goal/updated", "thread/name/updated", "thread/queue/changed", "thread/realtime/closed",
  "thread/realtime/error", "thread/realtime/itemAdded", "thread/realtime/outputAudio/delta", "thread/realtime/sdp",
  "thread/realtime/started", "thread/realtime/transcript/delta", "thread/realtime/transcript/done", "thread/reverted",
  "thread/settings/updated", "thread/started", "thread/status/changed", "thread/tokenUsage/updated", "thread/unarchived",
  "turn/completed", "turn/diff/updated", "turn/moderationMetadata", "turn/plan/updated", "turn/started", "warning",
  "windows/worldWritableWarning", "windowsSandbox/setupCompleted",
]);

const ACCOUNT_AUTH_MUTATIONS = new Set(["account/login/start", "account/login/cancel", "account/logout"]);
const ACCOUNT_PROBES = new Set(["account/read", "account/rateLimits/read", "account/usage/read", "account/workspaceMessages/read"]);
const AGGREGATE_READS = new Set(["thread/list", "thread/search", "thread/loaded/list"]);
const CAPABILITY_MUTATIONS = /^(?:config\/|skills\/|plugin\/|marketplace\/)/;
const PRIMARY_HOST = /^(?:fs\/|command\/|process\/|fuzzyFileSearch)/;
const THREAD_PREFIX = /^(?:thread\/|turn\/)/;

export function classifyClientMethod(method: unknown, params?: unknown): ClientRoute {
  if (typeof method !== "string" || !CLIENT_METHODS.has(method)) return "unknown";
  if (method === "initialize") return "fanout_initialize_intersection";
  if (method === "thread/start") return "balance_new_thread";
  if (AGGREGATE_READS.has(method)) return "fanout_aggregate_read_with_router_cursor";
  if (method === "threadSection/list") return "fanout_aggregate_namespaced_sections";
  if (method.startsWith("threadSection/")) return "primary_only_section_mutation";
  if (THREAD_PREFIX.test(method) && (hasThreadId(params) || method === "review/start" || method.startsWith("turn/"))) {
    return "persisted_thread_owner";
  }
  if (hasThreadId(params)) return "thread_owner_if_present_else_primary";
  if (ACCOUNT_AUTH_MUTATIONS.has(method)) return "reject_in_balanced_mode_use_manual_enrollment";
  if (ACCOUNT_PROBES.has(method)) return "primary_to_desktop_internal_per_home_probe";
  if (method.startsWith("account/")) return "primary_only_explicit_account_action";
  if (CAPABILITY_MUTATIONS.test(method)) return "primary_only_then_invalidate_capability_fingerprints";
  if (method.startsWith("app/")) return "primary_to_desktop_internal_per_home_probe";
  if (method.startsWith("mcpServer")) return "primary_if_no_thread_then_revalidate_capabilities";
  if (PRIMARY_HOST.test(method)) return "host_primary_only_collision_scoped";
  return "primary_only_fail_if_semantics_require_account_or_thread_inference";
}

export function classifyServerNotification(method: unknown, params?: unknown): ServerNotificationRoute {
  if (typeof method !== "string" || !SERVER_NOTIFICATION_METHODS.has(method)) return "unknown";
  if (hasThreadId(params) || /^(?:thread\/|turn\/|item\/|hook\/)/.test(method)) return "verify_persisted_owner_then_forward";
  if (/^(?:account\/|app\/|skills\/|mcpServer\/)/.test(method) || method.includes("config")) {
    return "ingest_per_home_primary_forward_only_redacted_control_projection";
  }
  return "primary_forward_or_origin_correlation_only";
}

export function isKnownServerRequest(method: unknown): boolean {
  return typeof method === "string" && SERVER_REQUEST_METHODS.has(method);
}

export function hasThreadId(params: unknown): boolean {
  return isPlainRecord(params) && typeof params.threadId === "string" && params.threadId.length > 0;
}

export function threadIdFrom(params: unknown): string | null {
  if (!isPlainRecord(params)) return null;
  if (typeof params.threadId === "string" && params.threadId.length > 0) return params.threadId;
  const thread = params.thread;
  return isPlainRecord(thread) && typeof thread.id === "string" && thread.id.length > 0 ? thread.id : null;
}

export function parseJsonRpcLine(line: string): JsonRpcMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  if (typeof parsed.method === "string") {
    if (Object.prototype.hasOwnProperty.call(parsed, "id")) {
      if (!isJsonRpcId(parsed.id)) return null;
      return parsed as unknown as JsonRpcRequest;
    }
    return parsed as unknown as JsonRpcNotification;
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "id") && isJsonRpcId(parsed.id)) return parsed as unknown as JsonRpcResponse;
  return null;
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !("method" in message) && "id" in message;
}

export interface LiveCorrelation extends CorrelationRecord {
  internalId: string;
}

/**
 * Maps every cross-process JSON-RPC id through a monotonic mux-owned nonce.
 * The desktop id and child id are never used in the opposite direction and a
 * terminal response consumes the record exactly once.
 */
export class CorrelationTable {
  private nonce = 0n;
  private readonly records = new Map<string, LiveCorrelation>();
  private readonly externalIds = new Map<string, string>();
  private readonly recordExternalKeys = new Map<string, string>();

  constructor(
    records: CorrelationRecord[] = [],
    private readonly persist?: (records: CorrelationRecord[]) => void,
  ) {
    for (const record of records) {
      if (!isJsonRpcId(record.originalId) || !isOpaqueAccountId(record.childOpaqueAccountId)) continue;
      const parsed = parseInternalId(`ar1:${record.direction === "client_to_child" ? "c" : "s"}:${record.muxNonce}`);
      if (!parsed) continue;
      const internalId = parsed.id;
      this.records.set(internalId, { ...record, internalId });
      const key = externalKey(record.direction, record.originalId);
      this.externalIds.set(key, internalId);
      this.recordExternalKeys.set(internalId, key);
      const numeric = BigInt(record.muxNonce);
      if (numeric > this.nonce) this.nonce = numeric;
    }
  }

  create(
    direction: CorrelationDirection,
    childOpaqueAccountId: OpaqueAccountId,
    originalId: JsonRpcId,
    method: string,
    scope = "",
  ): LiveCorrelation {
    if (!isJsonRpcId(originalId) || typeof method !== "string" || method.length < 1 || method.length > 256) {
      throw new Error("invalid JSON-RPC correlation");
    }
    const external = `${externalKey(direction, originalId)}:${scope}`;
    if (this.externalIds.has(external)) throw new Error("duplicate active JSON-RPC id");
    this.nonce += 1n;
    if (this.nonce > 99_999_999_999_999_999_999n) throw new Error("account-router nonce exhausted");
    const internalId = `ar1:${direction === "client_to_child" ? "c" : "s"}:${this.nonce}`;
    const record: LiveCorrelation = {
      schemaVersion: 1,
      direction,
      childOpaqueAccountId,
      muxNonce: this.nonce.toString(),
      originalId,
      method,
      dispatchState: "prepared",
      internalId,
    };
    this.records.set(internalId, record);
    this.externalIds.set(external, internalId);
    this.recordExternalKeys.set(internalId, external);
    this.save();
    return record;
  }

  get(internalId: unknown): LiveCorrelation | null {
    return typeof internalId === "string" ? this.records.get(internalId) ?? null : null;
  }

  mark(internalId: string, state: DispatchState): LiveCorrelation | null {
    const record = this.records.get(internalId);
    if (!record) return null;
    record.dispatchState = state;
    this.save();
    return record;
  }

  consume(internalId: unknown, direction: CorrelationDirection, childOpaqueAccountId: OpaqueAccountId): LiveCorrelation | null {
    const record = this.get(internalId);
    if (!record || record.direction !== direction || record.childOpaqueAccountId !== childOpaqueAccountId) return null;
    this.records.delete(record.internalId);
    const external = this.recordExternalKeys.get(record.internalId) ?? externalKey(direction, record.originalId);
    this.externalIds.delete(external);
    this.recordExternalKeys.delete(record.internalId);
    this.save();
    return { ...record, dispatchState: "terminal" };
  }

  acknowledgeChild(childOpaqueAccountId: OpaqueAccountId): void {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.childOpaqueAccountId === childOpaqueAccountId && record.dispatchState === "written") {
        record.dispatchState = "acknowledged";
        changed = true;
      }
    }
    if (changed) this.save();
  }

  remaining(): LiveCorrelation[] {
    return [...this.records.values()].map(({ internalId: _internalId, ...record }) => ({ ...record, internalId: _internalId }));
  }

  private save(): void {
    this.persist?.([...this.records.values()].map(({ internalId: _internalId, ...record }) => ({ ...record })));
  }
}

function externalKey(direction: CorrelationDirection, id: JsonRpcId): string {
  return `${direction}:${typeof id}:${String(id)}`;
}

function parseInternalId(value: string): { id: string } | null {
  return /^ar1:[cs]:[1-9][0-9]{0,19}$/.test(value) ? { id: value } : null;
}

/** The only advertised capability set is the value safely shared by every child. */
export function intersectCapabilities(values: unknown[]): unknown | null {
  if (values.length === 0) return null;
  const [first, ...rest] = values;
  return rest.reduce<unknown | null>((intersection, next) => intersectTwo(intersection, next), first);
}

function intersectTwo(left: unknown, right: unknown): unknown | null {
  if (left === null || right === null || typeof left !== typeof right) return null;
  if (typeof left !== "object") return Object.is(left, right) ? left : null;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return null;
    const rightValues = new Set(right.filter((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean"));
    return left.filter((value) => rightValues.has(value));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return null;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(left)) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) continue;
    const value = intersectTwo(left[key], right[key]);
    if (value !== null) result[key] = value;
  }
  return result;
}

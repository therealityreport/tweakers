import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

// This runtime is copied into the application as a standalone CommonJS tree.
// Keep this small canonicalizer vendored here; cross-lane golden tests bind it
// to the SDK implementation used by the installer without a runtime require.
const PROMOTION_POLICY_FILE_MAX_BYTES = 10 * 1024 * 1024;
const PROMOTION_POLICY_CANONICAL_MAX_CHARS = 12 * 1024 * 1024;
const PROMOTION_POLICY_MAX_DEPTH = 128;
const PROMOTION_POLICY_MAX_NODES = 250_000;
const PROMOTION_POLICY_HASH_DOMAIN = "tweakers-promotion-policy-v1\0";
const PERSISTED_ATOMS_KEY = "electron-persisted-atom-state";
const AGENT_MODES_KEY = "agent-mode-by-host-id";
const THREAD_PERMISSIONS_KEY = "heartbeat-thread-permissions-by-id";
const MCP_FORM_KEY = "electron-openai-mcp-form-elicitations-enabled";

interface CanonicalBudget {
  nodes: number;
}

/** Semantic, bounded and no-follow policy proof used by runtime observation. */
export function fingerprintPromotionPolicyPath(path: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !before.isFile()
      || before.size <= 0
      || before.size > PROMOTION_POLICY_FILE_MAX_BYTES
      || (before.mode & 0o777) !== 0o600
      || (currentUid !== null && before.uid !== currentUid)
    ) {
      throw new Error("Promotion policy state must be an owner-only bounded regular file");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      bytes.byteLength !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Promotion policy state changed while being read");
    }
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Promotion policy state must be valid UTF-8");
    }
    const canonical = canonicalPromotionPolicyText(raw);
    return createHash("sha256").update(PROMOTION_POLICY_HASH_DOMAIN).update(canonical).digest("hex");
  } finally {
    closeSync(fd);
  }
}

function canonicalPromotionPolicyText(raw: string): string {
  if (raw.length === 0 || raw.length > PROMOTION_POLICY_FILE_MAX_BYTES) {
    throw new Error("Promotion policy state must be non-empty and bounded");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Promotion policy state must be valid JSON");
  }
  assertNoDuplicateJsonKeys(raw);
  const root = requireRecord(parsed, "Promotion policy state root");
  const atomsSlot = policySlot(root, PERSISTED_ATOMS_KEY);
  const atoms = atomsSlot.present
    ? requireRecord(atomsSlot.value, "Promotion persisted atom state")
    : null;
  const modesSlot = atoms === null
    ? { present: false as const }
    : policyRecordSlot(atoms, AGENT_MODES_KEY, "Promotion agent-mode state");
  const localAgentMode = !modesSlot.present
    ? { present: false as const }
    : policySlot(modesSlot.value, "local");
  validatePolicySlot(localAgentMode, "Promotion local agent mode", isString);
  const threadPermissions = atoms === null
    ? { present: false as const }
    : projectThreadPermissions(atoms);
  const mcpFormElicitationsEnabled = policySlot(root, MCP_FORM_KEY);
  validatePolicySlot(mcpFormElicitationsEnabled, "Promotion MCP-form control", isBoolean);
  const projection = {
    schemaVersion: 1,
    mcpFormElicitationsEnabled,
    persistedAtoms: {
      present: atomsSlot.present,
      agentModes: {
        present: modesSlot.present,
        local: localAgentMode,
      },
      threadPermissions,
    },
  };
  const canonical = canonicalJson(projection, 0, { nodes: 0 });
  if (canonical.length > PROMOTION_POLICY_CANONICAL_MAX_CHARS) {
    throw new Error("Promotion policy projection is oversized");
  }
  return canonical;
}

function projectThreadPermissions(
  atoms: Record<string, unknown>,
): { present: false } | { present: true; value: Array<[string, Record<string, unknown>]> } {
  const slot = policyRecordSlot(atoms, THREAD_PERMISSIONS_KEY, "Promotion thread-permission state");
  if (!slot.present) return slot;
  const projected: Array<[string, Record<string, unknown>]> = [];
  for (const threadId of Object.keys(slot.value).sort()) {
    const record = requireRecord(slot.value[threadId], "Promotion thread-permission record");
    const activePermissionProfile = policySlot(record, "activePermissionProfile");
    const approvalPolicy = policySlot(record, "approvalPolicy");
    const sandboxPolicy = policySlot(record, "sandboxPolicy");
    const approvalsReviewer = policySlot(record, "approvalsReviewer");
    const runtimeWorkspaceRoots = policySlot(record, "runtimeWorkspaceRoots");
    validatePolicySlot(activePermissionProfile, "Promotion active permission profile", isNullOrRecord);
    validatePolicySlot(approvalPolicy, "Promotion approval policy", isStringOrRecord);
    validatePolicySlot(sandboxPolicy, "Promotion sandbox policy", isRecord);
    validatePolicySlot(approvalsReviewer, "Promotion approvals reviewer", isString);
    validatePolicySlot(runtimeWorkspaceRoots, "Promotion runtime workspace roots", isStringArray);
    projected.push([threadId, {
      activePermissionProfile,
      approvalPolicy,
      sandboxPolicy,
      approvalsReviewer,
      runtimeWorkspaceRoots,
    }]);
  }
  return { present: true, value: projected };
}

function validatePolicySlot(
  slot: { present: false } | { present: true; value: unknown },
  label: string,
  predicate: (value: unknown) => boolean,
): void {
  if (slot.present && !predicate(slot.value)) throw new Error(`${label} has an invalid value type`);
}

function isString(value: unknown): boolean {
  return typeof value === "string";
}

function isBoolean(value: unknown): boolean {
  return typeof value === "boolean";
}

function isRecord(value: unknown): boolean {
  return isPlainRecord(value);
}

function isNullOrRecord(value: unknown): boolean {
  return value === null || isPlainRecord(value);
}

function isStringOrRecord(value: unknown): boolean {
  return typeof value === "string" || isPlainRecord(value);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function policyRecordSlot(
  value: Record<string, unknown>,
  key: string,
  label: string,
): { present: false } | { present: true; value: Record<string, unknown> } {
  const slot = policySlot(value, key);
  if (!slot.present) return slot;
  return { present: true, value: requireRecord(slot.value, label) };
}

function policySlot(
  value: Record<string, unknown>,
  key: string,
): { present: false } | { present: true; value: unknown } {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? { present: true, value: value[key] }
    : { present: false };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** JSON.parse is last-write-wins; promotion policy must reject ambiguity. */
function assertNoDuplicateJsonKeys(raw: string): void {
  let offset = 0;
  let nodes = 0;
  const skipWhitespace = (): void => {
    while (offset < raw.length && /\s/.test(raw[offset]!)) offset += 1;
  };
  const parseString = (): string => {
    const start = offset;
    offset += 1;
    while (offset < raw.length) {
      const character = raw[offset]!;
      if (character === "\\") {
        offset += 2;
        continue;
      }
      offset += 1;
      if (character === "\"") return JSON.parse(raw.slice(start, offset)) as string;
    }
    throw new Error("Promotion policy state contains an unterminated string");
  };
  const parseValue = (depth: number): void => {
    nodes += 1;
    if (nodes > PROMOTION_POLICY_MAX_NODES) throw new Error("Promotion policy state has too many values");
    if (depth > PROMOTION_POLICY_MAX_DEPTH) throw new Error("Promotion policy state is too deeply nested");
    skipWhitespace();
    const character = raw[offset];
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[offset] === "}") { offset += 1; return; }
      while (offset < raw.length) {
        if (raw[offset] !== "\"") throw new Error("Promotion policy object key is invalid");
        const key = parseString();
        if (keys.has(key)) throw new Error("Promotion policy state contains a duplicate JSON key");
        keys.add(key);
        skipWhitespace();
        if (raw[offset] !== ":") throw new Error("Promotion policy object separator is invalid");
        offset += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (raw[offset] === "}") { offset += 1; return; }
        if (raw[offset] !== ",") throw new Error("Promotion policy object delimiter is invalid");
        offset += 1;
        skipWhitespace();
      }
      throw new Error("Promotion policy object is incomplete");
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (raw[offset] === "]") { offset += 1; return; }
      while (offset < raw.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (raw[offset] === "]") { offset += 1; return; }
        if (raw[offset] !== ",") throw new Error("Promotion policy array delimiter is invalid");
        offset += 1;
      }
      throw new Error("Promotion policy array is incomplete");
    }
    if (character === "\"") {
      parseString();
      return;
    }
    while (offset < raw.length && !/[\s,}\]]/.test(raw[offset]!)) offset += 1;
  };
  parseValue(0);
  skipWhitespace();
  if (offset !== raw.length) throw new Error("Promotion policy state has trailing content");
}

function canonicalJson(value: unknown, depth: number, budget: CanonicalBudget): string {
  budget.nodes += 1;
  if (budget.nodes > PROMOTION_POLICY_MAX_NODES) throw new Error("Promotion policy state has too many values");
  if (depth > PROMOTION_POLICY_MAX_DEPTH) throw new Error("Promotion policy state is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Promotion policy state contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, depth + 1, budget)).join(",")}]`;
  }
  const record = requireRecord(value, "Promotion policy value");
  const fields = Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1, budget)}`
  ));
  return `{${fields.join(",")}}`;
}

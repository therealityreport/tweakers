import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { TweakMcpServer } from "@therealityreport/tweakers-sdk";
import {
  fingerprint,
  planMcpConfigReconciliation,
  readMcpSyncState,
  reconcileMcpConfig,
} from "./mcp-reconciliation";
import type {
  McpConflict,
  McpSyncTweak,
  PreservedMcpOptionsByServerName,
} from "./mcp-sync";
import { discoverTweaks } from "./tweak-discovery";

export type McpModeHeadlessOperation = "reconcile" | "prove";
export type McpModeAppExperience = "chatgpt" | "tweakers";

export interface McpModeHeadlessRequest {
  schemaVersion: 1;
  operation: McpModeHeadlessOperation;
  appExperience: McpModeAppExperience;
  configPath: string;
  statePath: string;
  tweaksRoot: string;
  tweakersConfigPath: string;
}

export interface McpModeHeadlessResult {
  schemaVersion: 1;
  operation: McpModeHeadlessOperation;
  appExperience: McpModeAppExperience;
  ok: boolean;
  changed: boolean;
  restartRequired: boolean;
  desiredNames: string[];
  appliedNames: string[];
  conflicts: McpConflict[];
  preservedOptions: PreservedMcpOptionsByServerName;
  beforeFingerprint: string;
  afterFingerprint: string;
  error: string | null;
}

interface TweakersConfig {
  tweaker?: { safeMode?: boolean };
  tweaks?: Record<string, { enabled?: boolean }>;
  tweakHealth?: Record<string, { status?: string }>;
}

export function runMcpModeHeadless(input: unknown): McpModeHeadlessResult {
  const request = parseRequest(input);
  const ownedTweaks = discoverOwnedMcpTweaks(request.tweaksRoot);
  const desiredTweaks = request.appExperience === "chatgpt"
    ? []
    : selectEnabledTweaks(ownedTweaks, readTweakersConfig(request.tweakersConfigPath));
  const beforeBytes = readBytes(request.configPath);
  const beforeFingerprint = fingerprint(beforeBytes);

  if (request.operation === "prove") {
    return buildProofResult({
      request,
      ownedTweaks,
      desiredTweaks,
      beforeFingerprint,
      changedDuringReconcile: false,
      restartRequired: false,
    });
  }

  const receipt = reconcileMcpConfig({
    configPath: request.configPath,
    statePath: request.statePath,
    tweaks: desiredTweaks,
    ownedTweaks,
    trigger: "manual-repair",
  });
  const afterFingerprint = fingerprint(readBytes(request.configPath));
  return buildProofResult({
    request,
    ownedTweaks,
    desiredTweaks,
    beforeFingerprint: receipt.beforeFingerprint,
    changedDuringReconcile: beforeFingerprint !== afterFingerprint,
    restartRequired: receipt.restartRequired,
  });
}

function buildProofResult({
  request,
  ownedTweaks,
  desiredTweaks,
  beforeFingerprint,
  changedDuringReconcile,
  restartRequired,
}: {
  request: McpModeHeadlessRequest;
  ownedTweaks: McpSyncTweak[];
  desiredTweaks: McpSyncTweak[];
  beforeFingerprint: string;
  changedDuringReconcile: boolean;
  restartRequired: boolean;
}): McpModeHeadlessResult {
  const currentBytes = readBytes(request.configPath);
  const state = readMcpSyncState(request.statePath);
  const plan = planMcpConfigReconciliation(desiredTweaks, decodeUtf8(currentBytes), {
    ownedTweaks,
    preservedOptions: state?.preservedOptions,
    preservedApprovalPolicy: state?.preservedApprovalPolicy,
  });
  const exactNames = arraysEqual(plan.desiredNames, plan.appliedNames);
  const policyConflict = plan.approvalPolicy.status === "conflict";
  const ok = !plan.changed && plan.conflicts.length === 0 && !policyConflict && exactNames;
  return {
    schemaVersion: 1,
    operation: request.operation,
    appExperience: request.appExperience,
    ok,
    changed: request.operation === "prove" ? plan.changed : changedDuringReconcile,
    restartRequired,
    desiredNames: plan.desiredNames,
    appliedNames: plan.appliedNames,
    conflicts: plan.conflicts,
    preservedOptions: plan.preservedOptions,
    beforeFingerprint,
    afterFingerprint: fingerprint(currentBytes),
    error: ok
      ? null
      : policyConflict
        ? plan.approvalPolicy.error ?? "Approval policy conflict prevents an exact mode transition"
        : plan.conflicts.length > 0
        ? "MCP ownership conflict prevents an exact mode transition"
        : plan.changed
          ? "MCP configuration does not match the requested app experience"
          : "Applied MCP server names do not exactly match the desired set",
  };
}

function parseRequest(input: unknown): McpModeHeadlessRequest {
  if (!isRecord(input)) throw new Error("Headless MCP request must be a JSON object");
  const allowed = new Set([
    "schemaVersion",
    "operation",
    "appExperience",
    "configPath",
    "statePath",
    "tweaksRoot",
    "tweakersConfigPath",
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown headless MCP request field: ${unknown.join(", ")}`);
  if (input.schemaVersion !== 1) throw new Error("Unsupported headless MCP request schemaVersion");
  if (input.operation !== "reconcile" && input.operation !== "prove") {
    throw new Error("Headless MCP operation must be reconcile or prove");
  }
  if (input.appExperience !== "chatgpt" && input.appExperience !== "tweakers") {
    throw new Error("Headless MCP appExperience must be chatgpt or tweakers");
  }
  for (const key of ["configPath", "statePath", "tweaksRoot", "tweakersConfigPath"] as const) {
    const value = input[key];
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error(`Headless MCP ${key} must be an absolute path`);
    }
  }
  if (resolve(input.configPath as string) === resolve(input.statePath as string)) {
    throw new Error("Headless MCP configPath and statePath must be different files");
  }
  return input as unknown as McpModeHeadlessRequest;
}

function discoverOwnedMcpTweaks(tweaksRoot: string): McpSyncTweak[] {
  const owned = discoverTweaks(tweaksRoot)
    .filter((tweak) => tweak.manifest.mcp !== undefined)
    .map((tweak) => {
      assertValidMcp(tweak.manifest.id, tweak.manifest.mcp);
      return tweak;
    });
  return owned;
}

function assertValidMcp(id: string, value: TweakMcpServer | undefined): asserts value is TweakMcpServer {
  if (!value || typeof value.command !== "string" || value.command.length === 0) {
    throw new Error(`Installed tweak ${id} has an invalid MCP command`);
  }
  if (value.args !== undefined && (
    !Array.isArray(value.args) || value.args.some((argument) => typeof argument !== "string")
  )) {
    throw new Error(`Installed tweak ${id} has invalid MCP arguments`);
  }
  if (value.env !== undefined && (
    !isRecord(value.env) || Object.values(value.env).some((entry) => typeof entry !== "string")
  )) {
    throw new Error(`Installed tweak ${id} has an invalid MCP environment`);
  }
}

function readTweakersConfig(path: string): TweakersConfig {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Tweakers config must contain a JSON object");
  return parsed as TweakersConfig;
}

function selectEnabledTweaks(tweaks: McpSyncTweak[], config: TweakersConfig): McpSyncTweak[] {
  if (config.tweaker?.safeMode === true) return [];
  return tweaks.filter((tweak) => (
    config.tweakHealth?.[tweak.manifest.id]?.status !== "quarantined"
    && config.tweaks?.[tweak.manifest.id]?.enabled !== false
  ));
}

function readBytes(path: string): Buffer {
  return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("Malformed TOML: config.toml is not valid UTF-8");
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runCli(): void {
  try {
    const raw = readFileSync(0, "utf8");
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("Headless MCP request exceeds 64 KiB");
    const result = runMcpModeHeadless(JSON.parse(raw) as unknown);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli();

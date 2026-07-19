import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppExperience } from "./environment-profile.js";

export const MCP_MODE_HELPER_SCHEMA_VERSION = 1 as const;

export type McpModeHelperOperation = "reconcile" | "prove";

export interface McpModeHelperRequest {
  schemaVersion: typeof MCP_MODE_HELPER_SCHEMA_VERSION;
  operation: McpModeHelperOperation;
  appExperience: AppExperience;
  configPath: string;
  statePath: string;
  tweaksRoot: string;
  tweakersConfigPath: string;
}

export interface McpModeHelperConflict {
  observedName: string;
  canonicalName: string;
  reason: "canonical-collision" | "legacy-shape-mismatch" | "ambiguous-legacy";
}

export interface McpModeHelperResponse {
  schemaVersion: typeof MCP_MODE_HELPER_SCHEMA_VERSION;
  operation: McpModeHelperOperation;
  appExperience: AppExperience;
  ok: boolean;
  changed: boolean;
  desiredNames: string[];
  appliedNames: string[];
  conflicts: McpModeHelperConflict[];
  beforeFingerprint: string;
  afterFingerprint: string;
  preservedOptions: Record<string, { defaultToolsApprovalMode?: "approve" }>;
  restartRequired: boolean;
  error: string | null;
}

export interface McpModeBridgeOptions {
  helperFile?: string;
  nodeExecutable?: string;
  configPath: string;
  statePath: string;
  tweaksRoot: string;
  tweakersConfigPath: string;
  timeoutMs?: number;
}

export interface McpModeBridgeDependencies {
  run?: (
    executable: string,
    args: readonly string[],
    options: {
      cwd: string;
      encoding: "utf8";
      env: NodeJS.ProcessEnv;
      input: string;
      maxBuffer: number;
      stdio: ["pipe", "pipe", "pipe"];
      timeout: number;
    },
  ) => SpawnSyncReturns<string>;
}

export interface McpModeBridge {
  assertReady(): void;
  reconcile(appExperience: AppExperience): McpModeHelperResponse;
  prove(appExperience: AppExperience): boolean;
}

/**
 * The runtime build is copied beside the installer package. Execute its
 * headless entrypoint as a process boundary rather than importing CommonJS
 * runtime code into the ESM installer or coupling the installer to chokidar.
 */
export function defaultMcpModeHelperFile(): string {
  return fileURLToPath(new URL("../assets/runtime/mcp-mode-headless.js", import.meta.url));
}

export function createMcpModeBridge(
  options: McpModeBridgeOptions,
  dependencies: McpModeBridgeDependencies = {},
): McpModeBridge {
  const helperFile = options.helperFile ?? defaultMcpModeHelperFile();
  const executable = options.nodeExecutable ?? process.execPath;
  const timeout = Math.max(1, options.timeoutMs ?? 30_000);
  const run = dependencies.run ?? ((command, args, spawnOptions) => (
    spawnSync(command, [...args], spawnOptions)
  ));

  const assertReady = (): void => {
    if (!existsSync(helperFile)) {
      throw new Error(`Tweakers MCP mode helper is missing at ${helperFile}`);
    }
    let helperStat;
    try {
      helperStat = lstatSync(helperFile);
    } catch (error) {
      throw new Error(`Tweakers MCP mode helper is unreadable at ${helperFile}: ${errorMessage(error)}`);
    }
    if (!helperStat.isFile() || helperStat.isSymbolicLink()) {
      throw new Error(`Tweakers MCP mode helper is not a regular file at ${helperFile}`);
    }
  };

  const invoke = (
    operation: McpModeHelperOperation,
    appExperience: AppExperience,
  ): McpModeHelperResponse => {
    assertReady();
    const request: McpModeHelperRequest = {
      schemaVersion: MCP_MODE_HELPER_SCHEMA_VERSION,
      operation,
      appExperience,
      configPath: options.configPath,
      statePath: options.statePath,
      tweaksRoot: options.tweaksRoot,
      tweakersConfigPath: options.tweakersConfigPath,
    };
    const result = run(executable, [helperFile], {
      cwd: dirname(helperFile),
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      input: `${JSON.stringify(request)}\n`,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });
    if (result.error) {
      throw new Error(`Tweakers MCP mode helper could not run: ${errorMessage(result.error)}`);
    }

    if (result.signal !== null) {
      throw new Error(`Tweakers MCP mode helper was terminated by ${result.signal}`);
    }
    if (result.stdout.trim().length === 0 && result.status !== 0) {
      const detail = result.stderr.trim();
      throw new Error(`Tweakers MCP ${operation} failed${detail ? `: ${detail}` : ""}`);
    }
    const response = parseMcpModeHelperResponse(result.stdout, request);
    if (result.status !== 0 || !response.ok) {
      const detail = response.error
        ?? response.conflicts.map((conflict) => (
          `${conflict.observedName} -> ${conflict.canonicalName} (${conflict.reason})`
        )).join(", ")
        ?? result.stderr.trim();
      throw new Error(`Tweakers MCP ${operation} failed${detail ? `: ${detail}` : ""}`);
    }
    if (response.conflicts.length > 0) {
      throw new Error(`Tweakers MCP ${operation} returned conflicts despite reporting success`);
    }
    if (!sameStringSet(response.desiredNames, response.appliedNames)) {
      throw new Error(`Tweakers MCP ${operation} did not apply the exact desired server set`);
    }
    return response;
  };

  return {
    assertReady,
    reconcile(appExperience) {
      return invoke("reconcile", appExperience);
    },
    prove(appExperience) {
      const response = invoke("prove", appExperience);
      if (response.changed || response.beforeFingerprint !== response.afterFingerprint) {
        throw new Error("Tweakers MCP proof reported unapplied configuration changes");
      }
      return true;
    },
  };
}

export function parseMcpModeHelperResponse(
  stdout: string,
  expected: Pick<McpModeHelperRequest, "operation" | "appExperience">,
): McpModeHelperResponse {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Tweakers MCP mode helper returned invalid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "operation",
    "appExperience",
    "ok",
    "changed",
    "desiredNames",
    "appliedNames",
    "conflicts",
    "beforeFingerprint",
    "afterFingerprint",
    "preservedOptions",
    "restartRequired",
    "error",
  ])) {
    throw new Error("Tweakers MCP mode helper returned an invalid response shape");
  }
  if (value.schemaVersion !== MCP_MODE_HELPER_SCHEMA_VERSION
    || value.operation !== expected.operation
    || value.appExperience !== expected.appExperience
    || typeof value.ok !== "boolean"
    || typeof value.changed !== "boolean"
    || !isUniqueStringArray(value.desiredNames)
    || !isUniqueStringArray(value.appliedNames)
    || !Array.isArray(value.conflicts)
    || !value.conflicts.every(isMcpModeHelperConflict)
    || !sha256(value.beforeFingerprint)
    || !sha256(value.afterFingerprint)
    || !isPreservedOptions(value.preservedOptions)
    || typeof value.restartRequired !== "boolean"
    || (value.error !== null && typeof value.error !== "string")) {
    throw new Error("Tweakers MCP mode helper returned invalid response evidence");
  }
  return value as unknown as McpModeHelperResponse;
}

function isMcpModeHelperConflict(value: unknown): value is McpModeHelperConflict {
  return isRecord(value)
    && hasExactKeys(value, ["observedName", "canonicalName", "reason"])
    && nonEmptyString(value.observedName)
    && nonEmptyString(value.canonicalName)
    && ["canonical-collision", "legacy-shape-mismatch", "ambiguous-legacy"].includes(
      typeof value.reason === "string" ? value.reason : "",
    );
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(nonEmptyString)
    && new Set(value).size === value.length;
}

function isPreservedOptions(
  value: unknown,
): value is Record<string, { defaultToolsApprovalMode?: "approve" }> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([name, options]) => (
    name.trim().length > 0
    && isRecord(options)
    && hasExactKeys(
      options,
      options.defaultToolsApprovalMode === undefined ? [] : ["defaultToolsApprovalMode"],
    )
    && (options.defaultToolsApprovalMode === undefined || options.defaultToolsApprovalMode === "approve")
  ));
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length
    && [...left].sort().every((value, index) => value === sortedRight[index]);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The only JavaScript entrypoint launched by the fixed native manager
 * launcher. It accepts a small compiled protocol only; no descriptor argument,
 * shell text, generic command, or caller-supplied executable can cross this
 * boundary.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGER_PROTOCOL_VERSION,
  TWEAKERS_MANAGER_ID,
  type ManagerExecutableIdentityV1,
  type ManagerImpactV1,
  type TweakersManagerActionIdV1,
} from "./manager-contract.js";
import {
  ManagerActionAdapterError,
  TweakersManagerActionAdapter,
  createSealedTweakersManagerActionAdapter,
  type CancelManagerActionResult,
  type ExecuteManagerActionResult,
  type PrepareManagerActionResult,
} from "./manager-action-adapter.js";
import { createTweakersManagerStatusSnapshot } from "./manager-status.js";
import { ManagerStrictJsonError, parseManagerStrictJsonObject } from "./manager-strict-json.js";

const MANAGER_LAUNCHER_NAME = "Tweakers Manager Launcher";
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/;
const STATE_TOKEN = /^sha256:[a-f0-9]{64}$/;
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ACTION_IDS = new Set<TweakersManagerActionIdV1>([
  "environment.cancel",
  "environment.recover",
  "desktop-update.resume",
  "desktop-update.cancel",
  "environment.switch",
  "desktop-update.start",
  "repair.run",
  "self-update.run",
  "refresh.full",
  "app.restart-runtime-proof",
]);

interface ParsedStatusRequest {
  command: "status";
  requestId: string;
}

interface ParsedPrepareRequest {
  command: "prepare";
  requestId: string;
  operationId: string;
  actionId: TweakersManagerActionIdV1;
  stateToken: `sha256:${string}`;
  expiresAt: string;
}

interface ParsedOperationRequest {
  command: "execute" | "cancel";
  requestId: string;
  operationId: string;
}

type ParsedTweakersManagerRequest = ParsedStatusRequest | ParsedPrepareRequest | ParsedOperationRequest;

export interface TweakersManagerStatusResponseV1 {
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  managerId: typeof TWEAKERS_MANAGER_ID;
  requestId: string;
  generatedAt: string;
  stateToken: `sha256:${string}`;
  status: ReturnType<typeof createTweakersManagerStatusSnapshot>["status"];
  actions: ReturnType<typeof createTweakersManagerStatusSnapshot>["actions"];
}

export interface TweakersManagerPrepareResponseV1 extends PrepareManagerActionResult {
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  managerId: typeof TWEAKERS_MANAGER_ID;
  requestId: string;
  generatedAt: string;
  impact: ManagerImpactV1;
}

export interface TweakersManagerExecuteResponseV1 extends ExecuteManagerActionResult {
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  managerId: typeof TWEAKERS_MANAGER_ID;
  requestId: string;
  generatedAt: string;
}

export interface TweakersManagerCancelResponseV1 extends CancelManagerActionResult {
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  managerId: typeof TWEAKERS_MANAGER_ID;
  requestId: string;
  generatedAt: string;
}

export interface TweakersManagerErrorResponseV1 {
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  managerId: typeof TWEAKERS_MANAGER_ID;
  requestId: string | null;
  generatedAt: string;
  error: {
    code: ManagerCliErrorCode;
    message: string;
    retryable: false;
    currentStateToken?: `sha256:${string}`;
  };
}

export interface RunTweakersManagerCliDependencies {
  status?: typeof createTweakersManagerStatusSnapshot;
  executable?: () => ManagerExecutableIdentityV1;
  adapter?: TweakersManagerActionAdapter;
  now?: () => string;
  readStdin?: () => Uint8Array;
  write?: (line: string) => void;
}

type ManagerCliErrorCode =
  | "invalid_request"
  | "unsupported_protocol"
  | "unsupported_action"
  | "stale_state"
  | "operation_expired"
  | "operation_consumed"
  | "operation_conflict"
  | "cancelled"
  | "timeout"
  | "internal_error";

interface ManagerCliError extends Error {
  code: ManagerCliErrorCode;
  currentStateToken?: `sha256:${string}`;
}

/** Backward-compatible narrow parser used by the original status fixtures. */
export function parseTweakersManagerStatusArguments(argv: readonly string[]): { requestId: string } {
  const parsed = parseTweakersManagerArguments(argv);
  if (parsed.command !== "status") {
    throw managerCliError("unsupported_action", "This parser accepts only a status request");
  }
  return { requestId: parsed.requestId };
}

export function parseTweakersManagerArguments(argv: readonly string[]): ParsedTweakersManagerRequest {
  const command = argv[0] ?? "";
  if (command === "status") {
    if (argv.length !== 4 || argv[1] !== "--request-id" || argv[3] !== "--json") {
      throw managerCliError("invalid_request", "Expected: status --request-id <lowercase-uuid> --json");
    }
    return { command, requestId: parseUuid(argv[2], "request-id") };
  }
  if (command === "prepare") {
    if (argv.length !== 12
      || argv[1] !== "--request-id"
      || argv[3] !== "--operation-id"
      || argv[5] !== "--action"
      || argv[7] !== "--state-token"
      || argv[9] !== "--expires-at"
      || argv[11] !== "--json") {
      throw managerCliError("invalid_request", "Expected: prepare --request-id <uuid> --operation-id <uuid> --action <fixed-id> --state-token <sha256> --expires-at <rfc3339> --json");
    }
    const actionId = argv[6] as TweakersManagerActionIdV1;
    if (!ACTION_IDS.has(actionId)) throw managerCliError("unsupported_action", `Unknown manager action: ${argv[6] ?? ""}`);
    const stateToken = argv[8] ?? "";
    if (!STATE_TOKEN.test(stateToken)) throw managerCliError("invalid_request", "state-token must be a sha256 digest");
    const expiresAt = argv[10] ?? "";
    if (!RFC3339.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt))) {
      throw managerCliError("invalid_request", "expires-at must be RFC3339");
    }
    return {
      command,
      requestId: parseUuid(argv[2], "request-id"),
      operationId: parseUuid(argv[4], "operation-id"),
      actionId,
      stateToken: stateToken as `sha256:${string}`,
      expiresAt,
    };
  }
  if (command === "execute" || command === "cancel") {
    if (argv.length !== 6 || argv[1] !== "--request-id" || argv[3] !== "--operation-id" || argv[5] !== "--json") {
      throw managerCliError("invalid_request", `Expected: ${command} --request-id <uuid> --operation-id <uuid> --json`);
    }
    return {
      command,
      requestId: parseUuid(argv[2], "request-id"),
      operationId: parseUuid(argv[4], "operation-id"),
    };
  }
  if (command) throw managerCliError("unsupported_action", `Unsupported Tweakers manager command: ${command}`);
  throw managerCliError("invalid_request", "Expected a manager command");
}

/**
 * Return an exit code rather than calling process.exit() so stdout is flushed
 * and tests can prove every request emits exactly one JSON document first.
 */
export async function runTweakersManagerCli(
  argv: readonly string[],
  dependencies: RunTweakersManagerCliDependencies = {},
): Promise<number> {
  const write = dependencies.write ?? ((line: string) => writeSync(1, line));
  const now = dependencies.now ?? (() => new Date().toISOString());
  let requestId: string | null = maybeRequestId(argv);
  try {
    const parsed = parseTweakersManagerArguments(argv);
    requestId = parsed.requestId;
    const executable = (dependencies.executable ?? resolveManagerExecutableIdentity)();
    // The status response and prepare/execute path must use the same fixed
    // adapter instance so allowedActions cannot advertise a capability that
    // the sealed process did not link.
    const adapter = dependencies.adapter ?? createSealedTweakersManagerActionAdapter();
    if (parsed.command === "status") {
      const snapshot = (dependencies.status ?? createTweakersManagerStatusSnapshot)({
        executable,
        enabledActionIds: adapterActionIds(adapter),
      });
      const response: TweakersManagerStatusResponseV1 = {
        protocolVersion: snapshot.protocolVersion,
        managerId: snapshot.managerId,
        requestId: parsed.requestId,
        generatedAt: snapshot.generatedAt,
        stateToken: snapshot.stateToken,
        status: snapshot.status,
        actions: snapshot.actions,
      };
      writeJson(write, response);
      return 0;
    }

    if (parsed.command === "prepare") {
      const parameters = parsePrepareParameters((dependencies.readStdin ?? (() => readFileSync(0)))(), parsed.actionId);
      const prepared = await adapter.prepare({
        requestId: parsed.requestId,
        operationId: parsed.operationId,
        actionId: parsed.actionId,
        stateToken: parsed.stateToken,
        expiresAt: parsed.expiresAt,
        parameters,
        executable,
      });
      const response: TweakersManagerPrepareResponseV1 = {
        protocolVersion: MANAGER_PROTOCOL_VERSION,
        managerId: TWEAKERS_MANAGER_ID,
        requestId: parsed.requestId,
        generatedAt: safeNow(now),
        ...prepared,
      };
      writeJson(write, response);
      return 0;
    }
    if (parsed.command === "execute") {
      const executed = await adapter.execute({ operationId: parsed.operationId, executable });
      const response: TweakersManagerExecuteResponseV1 = {
        protocolVersion: MANAGER_PROTOCOL_VERSION,
        managerId: TWEAKERS_MANAGER_ID,
        requestId: parsed.requestId,
        generatedAt: safeNow(now),
        ...executed,
      };
      writeJson(write, response);
      return 0;
    }
    const cancelled = await adapter.cancel({ operationId: parsed.operationId, executable });
    const response: TweakersManagerCancelResponseV1 = {
      protocolVersion: MANAGER_PROTOCOL_VERSION,
      managerId: TWEAKERS_MANAGER_ID,
      requestId: parsed.requestId,
      generatedAt: safeNow(now),
      ...cancelled,
    };
    writeJson(write, response);
    return 0;
  } catch (error) {
    const typed = toManagerCliError(error);
    const response: TweakersManagerErrorResponseV1 = {
      protocolVersion: MANAGER_PROTOCOL_VERSION,
      managerId: TWEAKERS_MANAGER_ID,
      requestId,
      generatedAt: safeNow(now),
      error: {
        code: typed.code,
        message: typed.message,
        retryable: false,
        ...(typed.currentStateToken === undefined ? {} : { currentStateToken: typed.currentStateToken }),
      },
    };
    writeJson(write, response);
    return 64;
  }
}

function adapterActionIds(adapter: TweakersManagerActionAdapter): readonly TweakersManagerActionIdV1[] {
  // Narrow test doubles may only model the invoked method. A missing method is
  // conservative: status advertises no action rather than assuming one.
  const candidate = adapter as unknown as { actionIds?: unknown };
  return typeof candidate.actionIds === "function"
    ? (candidate.actionIds as () => readonly TweakersManagerActionIdV1[])()
    : [];
}

function parsePrepareParameters(input: Uint8Array, actionId: TweakersManagerActionIdV1): Record<string, never> {
  let parameters: Record<string, unknown>;
  try {
    parameters = parseManagerStrictJsonObject(input, { maxBytes: 64 * 1024, label: "prepare parameters" });
  } catch (error) {
    if (error instanceof ManagerStrictJsonError) throw managerCliError("invalid_request", error.message);
    throw error;
  }
  // All T5-enabled actions deliberately accept no host-supplied values. Their
  // target receipt is captured from status at prepare time, never supplied by
  // UI input. Later families must add a dedicated exact schema here.
  if (Object.keys(parameters).length !== 0) {
    throw managerCliError("invalid_request", `${actionId} requires an exact empty JSON object`);
  }
  return {};
}

/**
 * This does not repair or create anything. The launcher verifies stronger
 * ownership/mode/seal conditions before Node starts; the bundle reports an
 * unresolved identity instead of accepting an arbitrary launcher path when
 * directly invoked outside that boundary.
 */
export function resolveManagerExecutableIdentity(entrypoint = process.argv[1]): ManagerExecutableIdentityV1 {
  try {
    if (!entrypoint) throw new Error("manager bundle entrypoint is unavailable");
    const bundle = realpathSync(requireExactAbsolutePath(entrypoint, "manager bundle entrypoint"));
    const launcher = join(dirname(bundle), MANAGER_LAUNCHER_NAME);
    const stat = lstatSync(launcher);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("fixed sibling launcher is not a regular single-link file");
    }
    const canonicalLauncher = realpathSync(launcher);
    if (canonicalLauncher !== launcher) throw new Error("fixed sibling launcher resolves through a link");
    return {
      state: "resolved",
      path: canonicalLauncher,
      sha256: createHash("sha256").update(readFileSync(canonicalLauncher)).digest("hex"),
    };
  } catch (error) {
    return { state: "unresolved", reason: errorMessage(error) };
  }
}

function parseUuid(value: string | undefined, label: string): string {
  if (!value || !LOWERCASE_UUID.test(value)) throw managerCliError("invalid_request", `${label} must be a lowercase RFC4122 UUID`);
  return value;
}

function maybeRequestId(argv: readonly string[]): string | null {
  const index = argv.indexOf("--request-id");
  const candidate = index >= 0 ? argv[index + 1] ?? "" : "";
  return LOWERCASE_UUID.test(candidate) ? candidate : null;
}

function managerCliError(code: ManagerCliErrorCode, message: string, currentStateToken?: `sha256:${string}`): ManagerCliError {
  const error = new Error(message) as ManagerCliError;
  error.code = code;
  error.currentStateToken = currentStateToken;
  return error;
}

function toManagerCliError(error: unknown): ManagerCliError {
  if (error instanceof ManagerActionAdapterError) {
    return managerCliError(error.code, error.message, error.currentStateToken);
  }
  if (isManagerCliError(error)) return error;
  return managerCliError("internal_error", `Unable to run Tweakers manager request: ${errorMessage(error)}`);
}

function isManagerCliError(error: unknown): error is ManagerCliError {
  return error instanceof Error
    && (error as Partial<ManagerCliError>).code !== undefined
    && ["invalid_request", "unsupported_protocol", "unsupported_action", "stale_state", "operation_expired", "operation_consumed", "operation_conflict", "cancelled", "timeout", "internal_error"].includes((error as ManagerCliError).code);
}

function writeJson(write: (line: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

function safeNow(now: () => string): string {
  try {
    const value = now();
    return RFC3339.test(value) && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function requireExactAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an exact absolute path`);
  return path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint || !isAbsolute(entrypoint)) return false;
  try {
    return realpathSync(entrypoint) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = await runTweakersManagerCli(process.argv.slice(2));
}

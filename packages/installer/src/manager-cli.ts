/**
 * The only JavaScript entrypoint launched by the fixed native manager
 * launcher. It accepts a small compiled protocol only; no descriptor argument,
 * shell text, generic command, or caller-supplied executable can cross this
 * boundary.
 */
import { readFileSync, realpathSync } from "node:fs";
import { isTweakersManagerSection, type TweakersManagerSection } from "@therealityreport/tweakers-sdk";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGER_PROTOCOL_VERSION,
  TWEAKERS_MANAGER_ID,
  TWEAKERS_MANAGER_ACTION_IDS_V1,
  type ManagerActionAvailabilityV1,
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
import { createTweakersManagerStatusSnapshot, managerStatusPaths } from "./manager-status.js";
import { ManagerStrictJsonError, parseManagerStrictJsonObject } from "./manager-strict-json.js";
import { resolveManagerExecutableIdentity } from "./manager-launcher-identity.js";
import { resolveSealedTweakersManagerUserRoot } from "./manager-descriptor.js";
import {
  OFFLINE_MIGRATION_MANAGER_RUN_COMMAND,
  runOfflineMigrationLauncherManagerCommand,
} from "./offline-migration-launcher.js";
import {
  NATIVE_HISTORY_ACTIVATION_MANAGER_RUN_COMMAND,
  runNativeHistoryActivationManagerCommand,
} from "./native-history-activation.js";
// Operator-only preparation API. Importing the immutable bundle does not run
// its CLI; these exports add no public action or native launcher argv route.
export {
  prepareNativeHistoryActivationContext,
  armNativeHistoryActivationLaunchAgent,
} from "./native-history-activation.js";

import {
  PORTABLE_DESKTOP_PRELAUNCH_MANAGER_RUN_COMMAND,
  PORTABLE_DESKTOP_HANDOFF_OFFICIAL_MANAGER_RUN_COMMAND,
  PORTABLE_DESKTOP_HANDOFF_TWEAKERS_MANAGER_RUN_COMMAND,
  runPortableDesktopManagerCommand,
} from "./portable-desktop-launch.js";

const STATE_TOKEN = /^sha256:[a-f0-9]{64}$/;
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ACTION_IDS = new Set<TweakersManagerActionIdV1>([
  ...TWEAKERS_MANAGER_ACTION_IDS_V1,
]);
// The manager status contract intentionally exposes only the two Tweakers
// actions consumed by the public host. `official-source.register` remains an
// internal prepare/execute capability used to establish the source binding
// for an independent refresh; it must not widen the public action list.
const PUBLIC_STATUS_ACTION_IDS = [
  "refresh.injected",
  "refresh.independent",
] as const satisfies readonly TweakersManagerActionIdV1[];

interface ParsedDoctorRequest {
  command: "doctor-status" | "doctor-action" | "doctor-open" | "doctor-run";
  requestId: string;
}
interface ParsedManagerOpenRequest {
  command: "manager-open";
  requestId: string;
  section: TweakersManagerSection;
}

interface ParsedStatusRequest {
  command: "status";
  requestId: string;
}

/**
 * This is intentionally a separate fixed protocol command, not another
 * public status action. It lets the independent reapply surface discover the
 * single prerequisite it may offer for confirmation without turning source
 * registration into a generic host-selected action.
 */
interface ParsedOfficialSourceRegistrationRequest {
  command: "official-source-registration";
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

type ParsedTweakersManagerRequest = ParsedDoctorRequest | ParsedStatusRequest | ParsedManagerOpenRequest
  | ParsedOfficialSourceRegistrationRequest
  | ParsedPrepareRequest
  | ParsedOperationRequest;

export interface TweakersManagerStatusResponseV1 {
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  managerId: typeof TWEAKERS_MANAGER_ID;
  requestId: string;
  generatedAt: string;
  stateToken: `sha256:${string}`;
  status: ReturnType<typeof createTweakersManagerStatusSnapshot>["status"];
  actions: ReturnType<typeof createTweakersManagerStatusSnapshot>["actions"];
}

/**
 * Narrow source-registration discovery surface for the independent reapply
 * flow. The generic `status` command keeps its two public actions and this
 * response deliberately omits the broader manager dashboard.
 */
export interface TweakersManagerOfficialSourceRegistrationResponseV1 {
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  managerId: typeof TWEAKERS_MANAGER_ID;
  requestId: string;
  generatedAt: string;
  stateToken: `sha256:${string}`;
  officialSourceRegistration: ManagerActionAvailabilityV1 & {
    actionId: "official-source.register";
  };
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
  /** Explicit test/CLI root; a launched sealed manager uses the canonical global root. */
  userRoot?: () => string;
  now?: () => string;
  readStdin?: () => Uint8Array;
  write?: (line: string) => void;
}

const MANAGER_CLI_ERROR_CODES = [
  "invalid_request",
  "unsupported_protocol",
  "unsupported_action",
  "stale_state",
  "operation_expired",
  "operation_consumed",
  "operation_conflict",
  "cancelled",
  "timeout",
  "internal_error",
] as const;

type ManagerCliErrorCode = typeof MANAGER_CLI_ERROR_CODES[number];

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
  if (command === "manager-open") {
    if (argv.length !== 6 || argv[1] !== "--request-id" || argv[3] !== "--section"
      || !isTweakersManagerSection(argv[4]) || argv[5] !== "--json") {
      throw managerCliError("invalid_request", "Expected: manager-open --request-id <uuid> --section <overview|updates|doctor> --json");
    }
    return { command, requestId: parseUuid(argv[2], "request-id"), section: argv[4] };
  }
  if (command === "doctor-status" || command === "doctor-action" || command === "doctor-open" || command === "doctor-run") {
    if (argv.length !== 4 || argv[1] !== "--request-id" || argv[3] !== "--json") throw managerCliError("invalid_request", "Invalid fixed Doctor invocation");
    return { command, requestId: parseUuid(argv[2], "request-id") };
  }
  if (command === "status") {
    if (argv.length !== 4 || argv[1] !== "--request-id" || argv[3] !== "--json") {
      throw managerCliError("invalid_request", "Expected: status --request-id <lowercase-uuid> --json");
    }
    return { command, requestId: parseUuid(argv[2], "request-id") };
  }
  if (command === "official-source-registration") {
    if (argv.length !== 4 || argv[1] !== "--request-id" || argv[3] !== "--json") {
      throw managerCliError("invalid_request", "Expected: official-source-registration --request-id <lowercase-uuid> --json");
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
  const output: string[] = [];
  const write = dependencies.write ?? ((line: string) => { output.push(line); });
  const now = dependencies.now ?? (() => new Date().toISOString());
  let requestId: string | null = maybeRequestId(argv);
  try {
    const parsed = parseTweakersManagerArguments(argv);
    requestId = parsed.requestId;
    const executable = (dependencies.executable ?? resolveManagerExecutableIdentity)();
    const userRoot = dependencies.userRoot ?? resolveSealedTweakersManagerUserRoot;
    const boundUserRoot = userRoot();
    // The status response and prepare/execute path must use the same fixed
    // adapter instance so allowedActions cannot advertise a capability that
    // the sealed process did not link.
    const adapter = dependencies.adapter ?? createSealedTweakersManagerActionAdapter({ userRoot: () => boundUserRoot });
    const snapshot = (officialSourceVerification: "projected" | "strict" = "projected") => (dependencies.status ?? createTweakersManagerStatusSnapshot)({
      executable,
      paths: managerStatusPaths(boundUserRoot),
      enabledActionIds: adapterActionIds(adapter),
      officialSourceVerification,
    });
    if (parsed.command === "manager-open" || parsed.command === "doctor-status" || parsed.command === "doctor-action" || parsed.command === "doctor-open" || parsed.command === "doctor-run") {
      if (executable.state !== "resolved") throw managerCliError("invalid_request", "Doctor requires the verified manager launcher");
      const doctor = await import("./doctor-actions.js");
      const report = await doctor.runDoctorManagerCommand({ command: parsed.command, requestId: parsed.requestId,
        root: boundUserRoot, executable, ...(parsed.command === "manager-open" ? { section: parsed.section } : {}), input: parsed.command === "doctor-action"
          ? parseManagerStrictJsonObject((dependencies.readStdin ?? (() => readFileSync(0)))(), { maxBytes: 64 * 1024, label: "Doctor action" }) : undefined });
      writeJson(write, { ...report, requestId: parsed.requestId });
      return 0;
    }
    if (parsed.command === "status") {
      const status = snapshot();
      const response: TweakersManagerStatusResponseV1 = {
        protocolVersion: status.protocolVersion,
        managerId: status.managerId,
        requestId: parsed.requestId,
        generatedAt: status.generatedAt,
        stateToken: status.stateToken,
        status: status.status,
        actions: publicStatusActions(status.actions),
      };
      writeJson(write, response);
      return 0;
    }

    if (parsed.command === "official-source-registration") {
      const status = snapshot("strict");
      const response: TweakersManagerOfficialSourceRegistrationResponseV1 = {
        protocolVersion: status.protocolVersion,
        managerId: status.managerId,
        requestId: parsed.requestId,
        generatedAt: status.generatedAt,
        stateToken: status.stateToken,
        officialSourceRegistration: officialSourceRegistrationAction(status.actions),
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
    if (parsed.command !== "cancel") throw managerCliError("unsupported_action", "Unsupported manager command");
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
  } finally {
    // Flush outside the protocol error handler: a transport failure must not
    // append another JSON document to a partially delivered response.
    if (!dependencies.write && output.length > 0) await writeManagerStdout(output.join(""));
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

function publicStatusActions(
  actions: ReturnType<typeof createTweakersManagerStatusSnapshot>["actions"],
): ReturnType<typeof createTweakersManagerStatusSnapshot>["actions"] {
  return PUBLIC_STATUS_ACTION_IDS
    .map((actionId) => actions.find((action) => action.actionId === actionId))
    .filter((action): action is ReturnType<typeof createTweakersManagerStatusSnapshot>["actions"][number] => action !== undefined);
}

function officialSourceRegistrationAction(
  actions: ReturnType<typeof createTweakersManagerStatusSnapshot>["actions"],
): TweakersManagerOfficialSourceRegistrationResponseV1["officialSourceRegistration"] {
  const action = actions.find((candidate) => candidate.actionId === "official-source.register");
  if (action?.actionId === "official-source.register") {
    return {
      actionId: "official-source.register",
      available: action.available,
      reason: action.reason,
    };
  }
  // A status implementation that cannot account for this fixed internal
  // action must fail closed. Do not infer availability from any source path,
  // descriptor, or caller-provided input.
  return {
    actionId: "official-source.register",
    available: false,
    reason: "official-source registration is unavailable in this manager status snapshot",
  };
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

export { resolveManagerExecutableIdentity } from "./manager-launcher-identity.js";

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
    && MANAGER_CLI_ERROR_CODES.includes((error as ManagerCliError).code);
}

function writeJson(write: (line: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

function writeManagerStdout(text: string): Promise<void> {
  // Native callers supply nonblocking pipes. The stream handles partial
  // writes and EAGAIN; its callback confirms the whole response was flushed.
  return new Promise((resolve, reject) => {
    process.stdout.write(text, "utf8", (error) => error ? reject(error) : resolve());
  });
}

function safeNow(now: () => string): string {
  try {
    const value = now();
    return RFC3339.test(value) && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
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
  const argv = process.argv.slice(2);
  if (argv[0] === OFFLINE_MIGRATION_MANAGER_RUN_COMMAND) {
    // This fixed argv route is intentionally separate from the manager JSON
    // protocol. The launcher itself proves launchd PID/plist/context binding.
    runOfflineMigrationLauncherManagerCommand(argv);
    process.exitCode = 0;
  } else if (argv[0] === NATIVE_HISTORY_ACTIVATION_MANAGER_RUN_COMMAND) {
    // Private launchd route: the runner authenticates its exact operation,
    // context digest, manager generation, and launchd process before acting.
    await runNativeHistoryActivationManagerCommand(argv);
    process.exitCode = 0;
  } else if ([PORTABLE_DESKTOP_PRELAUNCH_MANAGER_RUN_COMMAND, PORTABLE_DESKTOP_HANDOFF_OFFICIAL_MANAGER_RUN_COMMAND,
    PORTABLE_DESKTOP_HANDOFF_TWEAKERS_MANAGER_RUN_COMMAND].some((command) => command === argv[0])) {
    const result = runPortableDesktopManagerCommand(argv);
    await writeManagerStdout(`${JSON.stringify(result.result)}\n`);
    process.exitCode = result.exitCode;
  } else {
    process.exitCode = await runTweakersManagerCli(argv);
  }
}

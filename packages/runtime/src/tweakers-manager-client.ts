import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, sep } from "node:path";
import {
  isDoctorReportV1,
  isTweakersManagerSection,
  type DoctorActionRequestV1,
  type DoctorReportV1,
  type TweakersManagerSection,
} from "@therealityreport/tweakers-sdk";

const MANAGER_ID = "com.thomashulihan.tweakers";
const MANAGER_REQUIREMENT = 'identifier "com.therealityreport.tweakers.manager-launcher" and certificate leaf = H"631275551276127985a524acf1f469bf5164d50d"';
const STATUS_TIMEOUT_MS = 10_000;
const PUBLIC_STATUS_ACTION_IDS = [
  "refresh.injected",
  "refresh.independent",
] as const;

export type TweakersManagerPublicStatusActionId = typeof PUBLIC_STATUS_ACTION_IDS[number];
type TweakersManagerPublicStartActionId =
  | "refresh.injected"
  | "refresh.independent";
type TweakersManagerPreparedActionId =
  | TweakersManagerPublicStartActionId
  | "official-source.register";

export interface TweakersManagerClientDependencies {
  homeDirectory(): string;
  readText(path: string): string;
  execute(executable: string, args: readonly string[], input?: string): string;
  executeAsync(executable: string, args: readonly string[], input?: string): Promise<string>;
  spawnDetached(executable: string, args: readonly string[]): void;
  createId(): string;
  now(): number;
}

export interface TweakersManagerStatus {
  stateToken: string;
  status: {
    environment?: {
      officialApp?: {
        state?: string;
        appPath?: string | null;
        bundleId?: string | null;
      };
    };
    chatgptAppUpdate?: unknown;
    tweakersPatch?: unknown;
    updater?: unknown;
  };
  actions: Array<{ actionId: TweakersManagerPublicStatusActionId; available: boolean; reason: string }>;
}

/**
 * This private manager capability is the only discovery path for the fixed
 * source-sealing prerequisite. It deliberately is not represented in the
 * generic public status action list.
 */
export interface TweakersManagerOfficialSourceRegistration {
  stateToken: string;
  officialSourceRegistration: {
    actionId: "official-source.register";
    available: boolean;
    reason: string;
  };
}

export function createTweakersManagerClient(overrides: Partial<TweakersManagerClientDependencies> = {}) {
  const deps: TweakersManagerClientDependencies = {
    homeDirectory: overrides.homeDirectory ?? homedir,
    readText: overrides.readText ?? ((path) => readFileSync(path, "utf8")),
    execute: overrides.execute ?? ((executable, args, input) => execFileSync(executable, [...args], {
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
      timeout: args[0] === "doctor-action" ? 120_000 : STATUS_TIMEOUT_MS,
      maxBuffer: args[0]?.startsWith("doctor-") ? 32 * 1024 * 1024 : 1024 * 1024,
    })),
    executeAsync: overrides.executeAsync ?? ((executable, args, input) => new Promise<string>((resolve, reject) => {
      const child = execFile(executable, [...args], {
        encoding: "utf8",
        timeout: args[0] === "doctor-action" ? 120_000 : STATUS_TIMEOUT_MS,
        maxBuffer: args[0]?.startsWith("doctor-") ? 32 * 1024 * 1024 : 1024 * 1024,
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin?.end(input);
    })),
    spawnDetached: overrides.spawnDetached ?? ((executable, args) => {
      const child = spawn(executable, [...args], { detached: true, stdio: "ignore" });
      child.unref();
    }),
    createId: overrides.createId ?? (() => randomUUID().toLowerCase()),
    now: overrides.now ?? Date.now,
  };
  const signatureCache = new Map<string, string>();
  const verified = () => verifiedManagerExecutable(deps, signatureCache);

  const statusFromResponse = (response: Record<string, unknown>): TweakersManagerStatus => {
    if (typeof response.stateToken !== "string" || !/^sha256:[a-f0-9]{64}$/.test(response.stateToken)) {
      throw new Error("Tweakers manager returned an invalid state token");
    }
    if (!response.status || typeof response.status !== "object" || !Array.isArray(response.actions)) {
      throw new Error("Tweakers manager returned a malformed status projection");
    }
    const actions = parsePublicStatusActions(response.actions);
    return {
      stateToken: response.stateToken,
      status: response.status as TweakersManagerStatus["status"],
      actions,
    };
  };

  const readStatusForExecutable = (executable: string): TweakersManagerStatus => {
    const requestId = deps.createId();
    return statusFromResponse(parseResponse(deps.execute(executable, ["status", "--request-id", requestId, "--json"]), requestId));
  };
  const readStatusForExecutableAsync = async (executable: string): Promise<TweakersManagerStatus> => {
    const requestId = deps.createId();
    return statusFromResponse(parseResponse(await deps.executeAsync(executable, ["status", "--request-id", requestId, "--json"]), requestId));
  };
  const readStatus = (): TweakersManagerStatus => readStatusForExecutable(verified());
  let statusInFlight: Promise<TweakersManagerStatus> | null = null;
  const readStatusAsync = (): Promise<TweakersManagerStatus> => {
    if (statusInFlight) return statusInFlight;
    statusInFlight = (async () => {
      const executable = await verifiedManagerExecutableAsync(deps, signatureCache);
      return readStatusForExecutableAsync(executable);
    })().finally(() => { statusInFlight = null; });
    return statusInFlight;
  };

  const registrationFromResponse = (response: Record<string, unknown>): TweakersManagerOfficialSourceRegistration => {
    if (typeof response.stateToken !== "string" || !/^sha256:[a-f0-9]{64}$/.test(response.stateToken)) {
      throw new Error("Tweakers manager returned an invalid official-source registration state token");
    }
    const action = response.officialSourceRegistration;
    if (!action || typeof action !== "object"
      || (action as Record<string, unknown>).actionId !== "official-source.register"
      || typeof (action as Record<string, unknown>).available !== "boolean"
      || typeof (action as Record<string, unknown>).reason !== "string") {
      throw new Error("Tweakers manager returned a malformed official-source registration capability");
    }
    return {
      stateToken: response.stateToken,
      officialSourceRegistration: action as TweakersManagerOfficialSourceRegistration["officialSourceRegistration"],
    };
  };
  const readOfficialSourceRegistrationForExecutable = (executable: string): TweakersManagerOfficialSourceRegistration => {
    const requestId = deps.createId();
    return registrationFromResponse(parseResponse(deps.execute(executable, [
      "official-source-registration", "--request-id", requestId, "--json",
    ]), requestId));
  };
  const readOfficialSourceRegistrationForExecutableAsync = async (executable: string): Promise<TweakersManagerOfficialSourceRegistration> => {
    const requestId = deps.createId();
    return registrationFromResponse(parseResponse(await deps.executeAsync(executable, [
      "official-source-registration", "--request-id", requestId, "--json",
    ]), requestId));
  };

  const startPreparedAction = (
    executable: string,
    actionId: TweakersManagerPreparedActionId,
    stateToken: string,
  ) => {
    const requestId = deps.createId();
    const operationId = deps.createId();
    const expiresAt = new Date(deps.now() + 60_000).toISOString();
    const prepared = parseResponse(deps.execute(executable, [
      "prepare", "--request-id", requestId,
      "--operation-id", operationId,
      "--action", actionId,
      "--state-token", stateToken,
      "--expires-at", expiresAt,
      "--json",
    ], "{}"), requestId);
    if (prepared.operationId !== operationId || prepared.prepared !== true) {
      throw new Error("Tweakers manager did not bind the requested operation");
    }
    const executeRequestId = deps.createId();
    deps.spawnDetached(executable, [
      "execute", "--request-id", executeRequestId,
      "--operation-id", operationId,
      "--json",
    ]);
    return { started: true as const, operationId };
  };
  const startPreparedActionAsync = async (
    executable: string,
    actionId: TweakersManagerPreparedActionId,
    stateToken: string,
  ) => {
    const requestId = deps.createId();
    const operationId = deps.createId();
    const expiresAt = new Date(deps.now() + 60_000).toISOString();
    const prepared = parseResponse(await deps.executeAsync(executable, [
      "prepare", "--request-id", requestId,
      "--operation-id", operationId,
      "--action", actionId,
      "--state-token", stateToken,
      "--expires-at", expiresAt,
      "--json",
    ], "{}"), requestId);
    if (prepared.operationId !== operationId || prepared.prepared !== true) {
      throw new Error("Tweakers manager did not bind the requested operation");
    }
    deps.spawnDetached(executable, [
      "execute", "--request-id", deps.createId(),
      "--operation-id", operationId,
      "--json",
    ]);
    return { started: true as const, operationId };
  };

  const startAction = (actionId: TweakersManagerPublicStartActionId) => {
    const executable = verified();
    const status = readStatusForExecutable(executable);
    const action = status.actions.find((candidate) => candidate.actionId === actionId);
    if (!action?.available) throw new Error(action?.reason ?? `Tweakers manager action ${actionId} is unavailable`);
    return startPreparedAction(executable, actionId, status.stateToken);
  };
  const startActionAsync = async (actionId: TweakersManagerPublicStartActionId) => {
    const executable = await verifiedManagerExecutableAsync(deps, signatureCache);
    // Mutations always obtain their own status and token; in-flight UI reads
    // must never authorize a later prepare.
    const status = await readStatusForExecutableAsync(executable);
    const action = status.actions.find((candidate) => candidate.actionId === actionId);
    if (!action?.available) throw new Error(action?.reason ?? `Tweakers manager action ${actionId} is unavailable`);
    return startPreparedActionAsync(executable, actionId, status.stateToken);
  };

  const readOfficialSourceRegistration = (): TweakersManagerOfficialSourceRegistration => (
    readOfficialSourceRegistrationForExecutable(verified())
  );
  const readOfficialSourceRegistrationAsync = async (): Promise<TweakersManagerOfficialSourceRegistration> => (
    readOfficialSourceRegistrationForExecutableAsync(await verifiedManagerExecutableAsync(deps, signatureCache))
  );

  const startOfficialSourceRegistration = () => {
    const executable = verified();
    const registration = readOfficialSourceRegistrationForExecutable(executable);
    if (!registration.officialSourceRegistration.available) {
      throw new Error(registration.officialSourceRegistration.reason);
    }
    // This fixed action takes no caller data. Its exact candidate binding is
    // captured by the sealed manager from this capability's state token.
    return startPreparedAction(executable, "official-source.register", registration.stateToken);
  };
  const startOfficialSourceRegistrationAsync = async () => {
    const executable = await verifiedManagerExecutableAsync(deps, signatureCache);
    const registration = await readOfficialSourceRegistrationForExecutableAsync(executable);
    if (!registration.officialSourceRegistration.available) throw new Error(registration.officialSourceRegistration.reason);
    return startPreparedActionAsync(executable, "official-source.register", registration.stateToken);
  };

  const doctorRequest = async (command: "doctor-status" | "doctor-action", input?: DoctorActionRequestV1): Promise<DoctorReportV1> => {
    const requestId = deps.createId();
    const executable = await verifiedManagerExecutableAsync(deps, signatureCache);
    const response = JSON.parse(await deps.executeAsync(executable, [command, "--request-id", requestId, "--json"], input ? JSON.stringify(input) : undefined));
    if (response.requestId !== requestId || !isDoctorReportV1(response)) throw new Error("Tweakers Manager returned an invalid Doctor report");
    return response;
  };
  const openManager = (section: TweakersManagerSection = "overview") => {
    // Keep this runtime boundary strict even though callers are typed: the
    // detached process is a fixed protocol and must never receive arbitrary UI text.
    if (!isTweakersManagerSection(section)) throw new Error("Invalid Tweakers Manager section");
    deps.spawnDetached(verified(), [
      "manager-open", "--request-id", deps.createId(), "--section", section, "--json",
    ]);
  };
  const openManagerAsync = async (section: TweakersManagerSection = "overview") => {
    if (!isTweakersManagerSection(section)) throw new Error("Invalid Tweakers Manager section");
    const executable = await verifiedManagerExecutableAsync(deps, signatureCache);
    deps.spawnDetached(executable, [
      "manager-open", "--request-id", deps.createId(), "--section", section, "--json",
    ]);
  };
  // Existing callers that specifically need the legacy Doctor launch remain
  // supported while new UI entry points use the unified Manager protocol.
  const openDoctor = () => deps.spawnDetached(verified(), ["doctor-open", "--request-id", deps.createId(), "--json"]);
  const openDoctorAsync = async () => {
    const executable = await verifiedManagerExecutableAsync(deps, signatureCache);
    deps.spawnDetached(executable, ["doctor-open", "--request-id", deps.createId(), "--json"]);
  };

  return {
    readStatus,
    readStatusAsync,
    startAction,
    startActionAsync,
    readOfficialSourceRegistration,
    readOfficialSourceRegistrationAsync,
    startOfficialSourceRegistration,
    startOfficialSourceRegistrationAsync,
    readDoctor: () => doctorRequest("doctor-status"),
    doctorAction: (input: DoctorActionRequestV1) => doctorRequest("doctor-action", input),
    openManager,
    openManagerAsync,
    openDoctor,
    openDoctorAsync,
  };
}

const defaultManagerClient = createTweakersManagerClient();

export function readTweakersDoctor(): Promise<DoctorReportV1> { return defaultManagerClient.readDoctor(); }
export function runTweakersDoctorAction(input: DoctorActionRequestV1): Promise<DoctorReportV1> { return defaultManagerClient.doctorAction(input); }
export function openTweakersManager(section: TweakersManagerSection = "overview"): void { defaultManagerClient.openManager(section); }
export function openTweakersDoctor(): void { defaultManagerClient.openDoctor(); }
export function openTweakersManagerAsync(section: TweakersManagerSection = "overview"): Promise<void> { return defaultManagerClient.openManagerAsync(section); }
export function openTweakersDoctorAsync(): Promise<void> { return defaultManagerClient.openDoctorAsync(); }

export function readTweakersManagerStatusAsync(): Promise<TweakersManagerStatus> { return defaultManagerClient.readStatusAsync(); }

export function readTweakersManagerStatus(): TweakersManagerStatus {
  return defaultManagerClient.readStatus();
}

export function startTweakersManagerAction(actionId: TweakersManagerPublicStartActionId) {
  return defaultManagerClient.startAction(actionId);
}
export function startTweakersManagerActionAsync(actionId: TweakersManagerPublicStartActionId) {
  return defaultManagerClient.startActionAsync(actionId);
}

export function readTweakersManagerOfficialSourceRegistration(): TweakersManagerOfficialSourceRegistration {
  return defaultManagerClient.readOfficialSourceRegistration();
}
export function readTweakersManagerOfficialSourceRegistrationAsync(): Promise<TweakersManagerOfficialSourceRegistration> {
  return defaultManagerClient.readOfficialSourceRegistrationAsync();
}

export function startTweakersManagerOfficialSourceRegistration() {
  return defaultManagerClient.startOfficialSourceRegistration();
}
export function startTweakersManagerOfficialSourceRegistrationAsync() {
  return defaultManagerClient.startOfficialSourceRegistrationAsync();
}

function managerExecutableIdentity(deps: TweakersManagerClientDependencies): { executable: string; signatureKey: string | null } {
  const descriptorRoot = join(deps.homeDirectory(), "Library", "Application Support", "Menu Bar", "manager-descriptors");
  const descriptorFile = join(descriptorRoot, `${MANAGER_ID}.json`);
  let descriptor: Record<string, unknown>;
  let descriptorText: string;
  try {
    descriptorText = deps.readText(descriptorFile);
    descriptor = JSON.parse(descriptorText) as Record<string, unknown>;
  } catch {
    throw new Error("The global Tweakers manager is unavailable or malformed");
  }
  const executable = descriptor.executable;
  const expectedRoot = join(deps.homeDirectory(), "Library", "Application Support", "Tweakers", "managers", MANAGER_ID, "generations") + sep;
  if (descriptor.schemaVersion !== 1
    || descriptor.managerId !== MANAGER_ID
    || descriptor.protocolVersion !== 1
    || typeof executable !== "string"
    || !isAbsolute(executable)
    || normalize(executable) !== executable
    || !executable.startsWith(expectedRoot)
    || basename(executable) !== "Tweakers Manager Launcher") {
    throw new Error("The global Tweakers manager descriptor is incompatible or blocked");
  }
  try {
    const stat = statSync(executable);
    return { executable, signatureKey: `${descriptorText}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
  } catch { return { executable, signatureKey: null }; }
}

function verifiedManagerExecutable(deps: TweakersManagerClientDependencies, signatureCache: Map<string, string>): string {
  const { executable, signatureKey } = managerExecutableIdentity(deps);
  if (signatureKey && signatureCache.get(executable) === signatureKey) return executable;
  try { deps.execute("/usr/bin/codesign", ["--verify", "--strict", `-R=${MANAGER_REQUIREMENT}`, executable]); }
  catch { throw new Error("The global Tweakers manager signature is invalid"); }
  if (signatureKey) {
    if (managerExecutableIdentity(deps).signatureKey !== signatureKey) throw new Error("The global Tweakers manager changed during verification");
    signatureCache.set(executable, signatureKey);
  }
  return executable;
}

async function verifiedManagerExecutableAsync(deps: TweakersManagerClientDependencies, signatureCache: Map<string, string>): Promise<string> {
  const { executable, signatureKey } = managerExecutableIdentity(deps);
  if (signatureKey && signatureCache.get(executable) === signatureKey) return executable;
  try { await deps.executeAsync("/usr/bin/codesign", ["--verify", "--strict", `-R=${MANAGER_REQUIREMENT}`, executable]); }
  catch { throw new Error("The global Tweakers manager signature is invalid"); }
  const after = managerExecutableIdentity(deps);
  if (after.executable !== executable || after.signatureKey !== signatureKey) throw new Error("The global Tweakers manager changed during verification");
  if (signatureKey) signatureCache.set(executable, signatureKey);
  return executable;
}

function parseResponse(output: string, requestId: string): Record<string, unknown> {
  let response: Record<string, unknown>;
  try {
    response = JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new Error("Tweakers manager returned malformed JSON");
  }
  if (response.protocolVersion !== 1 || response.managerId !== MANAGER_ID || response.requestId !== requestId) {
    throw new Error("Tweakers manager response identity is incompatible");
  }
  if (response.error && typeof response.error === "object") {
    const message = (response.error as Record<string, unknown>).message;
    throw new Error(typeof message === "string" ? message : "Tweakers manager rejected the request");
  }
  return response;
}

function parsePublicStatusActions(value: unknown[]): TweakersManagerStatus["actions"] {
  if (value.length !== PUBLIC_STATUS_ACTION_IDS.length) {
    throw new Error("Tweakers manager returned an incompatible public action projection");
  }
  const actions = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Tweakers manager returned an incompatible public action projection");
    }
    const action = candidate as Record<string, unknown>;
    const expectedActionId = PUBLIC_STATUS_ACTION_IDS[index];
    if (action.actionId !== expectedActionId || typeof action.available !== "boolean" || typeof action.reason !== "string") {
      throw new Error("Tweakers manager returned an incompatible public action projection");
    }
    return {
      actionId: expectedActionId,
      available: action.available,
      reason: action.reason,
    };
  });
  return actions;
}

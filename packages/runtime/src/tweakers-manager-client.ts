import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
    spawnDetached: overrides.spawnDetached ?? ((executable, args) => {
      const child = spawn(executable, [...args], { detached: true, stdio: "ignore" });
      child.unref();
    }),
    createId: overrides.createId ?? (() => randomUUID().toLowerCase()),
    now: overrides.now ?? Date.now,
  };

  const readStatusForExecutable = (executable: string): TweakersManagerStatus => {
    const requestId = deps.createId();
    const response = parseResponse(deps.execute(executable, ["status", "--request-id", requestId, "--json"]), requestId);
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

  const readStatus = (): TweakersManagerStatus => readStatusForExecutable(verifiedManagerExecutable(deps));

  const readOfficialSourceRegistrationForExecutable = (executable: string): TweakersManagerOfficialSourceRegistration => {
    const requestId = deps.createId();
    const response = parseResponse(deps.execute(executable, [
      "official-source-registration", "--request-id", requestId, "--json",
    ]), requestId);
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

  const startAction = (actionId: TweakersManagerPublicStartActionId) => {
    const executable = verifiedManagerExecutable(deps);
    const status = readStatusForExecutable(executable);
    const action = status.actions.find((candidate) => candidate.actionId === actionId);
    if (!action?.available) throw new Error(action?.reason ?? `Tweakers manager action ${actionId} is unavailable`);
    return startPreparedAction(executable, actionId, status.stateToken);
  };

  const readOfficialSourceRegistration = (): TweakersManagerOfficialSourceRegistration => (
    readOfficialSourceRegistrationForExecutable(verifiedManagerExecutable(deps))
  );

  const startOfficialSourceRegistration = () => {
    const executable = verifiedManagerExecutable(deps);
    const registration = readOfficialSourceRegistrationForExecutable(executable);
    if (!registration.officialSourceRegistration.available) {
      throw new Error(registration.officialSourceRegistration.reason);
    }
    // This fixed action takes no caller data. Its exact candidate binding is
    // captured by the sealed manager from this capability's state token.
    return startPreparedAction(executable, "official-source.register", registration.stateToken);
  };

  const doctorRequest = (command: "doctor-status" | "doctor-action", input?: DoctorActionRequestV1): DoctorReportV1 => {
    const requestId = deps.createId();
    const response = JSON.parse(deps.execute(verifiedManagerExecutable(deps), [command, "--request-id", requestId, "--json"], input ? JSON.stringify(input) : undefined));
    if (response.requestId !== requestId || !isDoctorReportV1(response)) throw new Error("Tweakers Doctor returned an invalid report");
    return response;
  };
  const openManager = (section: TweakersManagerSection = "overview") => {
    // Keep this runtime boundary strict even though callers are typed: the
    // detached process is a fixed protocol and must never receive arbitrary UI text.
    if (!isTweakersManagerSection(section)) throw new Error("Invalid Tweakers Manager section");
    deps.spawnDetached(verifiedManagerExecutable(deps), [
      "manager-open", "--request-id", deps.createId(), "--section", section, "--json",
    ]);
  };
  // Existing callers that specifically need the legacy Doctor launch remain
  // supported while new UI entry points use the unified Manager protocol.
  const openDoctor = () => deps.spawnDetached(verifiedManagerExecutable(deps), ["doctor-open", "--request-id", deps.createId(), "--json"]);

  return {
    readStatus,
    startAction,
    readOfficialSourceRegistration,
    startOfficialSourceRegistration,
    readDoctor: () => doctorRequest("doctor-status"),
    doctorAction: (input: DoctorActionRequestV1) => doctorRequest("doctor-action", input),
    openManager,
    openDoctor,
  };
}

export function readTweakersDoctor(): DoctorReportV1 { return createTweakersManagerClient().readDoctor(); }
export function runTweakersDoctorAction(input: DoctorActionRequestV1): DoctorReportV1 { return createTweakersManagerClient().doctorAction(input); }
export function openTweakersManager(section: TweakersManagerSection = "overview"): void { createTweakersManagerClient().openManager(section); }
export function openTweakersDoctor(): void { createTweakersManagerClient().openDoctor(); }

export function readTweakersManagerStatus(): TweakersManagerStatus {
  return createTweakersManagerClient().readStatus();
}

export function startTweakersManagerAction(actionId: TweakersManagerPublicStartActionId) {
  return createTweakersManagerClient().startAction(actionId);
}

export function readTweakersManagerOfficialSourceRegistration(): TweakersManagerOfficialSourceRegistration {
  return createTweakersManagerClient().readOfficialSourceRegistration();
}

export function startTweakersManagerOfficialSourceRegistration() {
  return createTweakersManagerClient().startOfficialSourceRegistration();
}

function verifiedManagerExecutable(deps: TweakersManagerClientDependencies): string {
  const descriptorRoot = join(deps.homeDirectory(), "Library", "Application Support", "Menu Bar", "manager-descriptors");
  const descriptorFile = join(descriptorRoot, `${MANAGER_ID}.json`);
  let descriptor: Record<string, unknown>;
  try {
    descriptor = JSON.parse(deps.readText(descriptorFile)) as Record<string, unknown>;
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
    deps.execute("/usr/bin/codesign", ["--verify", "--strict", `-R=${MANAGER_REQUIREMENT}`, executable]);
  } catch {
    throw new Error("The global Tweakers manager signature is invalid");
  }
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

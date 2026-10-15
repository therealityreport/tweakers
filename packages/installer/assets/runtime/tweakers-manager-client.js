"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTweakersManagerClient = createTweakersManagerClient;
exports.readTweakersDoctor = readTweakersDoctor;
exports.runTweakersDoctorAction = runTweakersDoctorAction;
exports.openTweakersManager = openTweakersManager;
exports.openTweakersDoctor = openTweakersDoctor;
exports.openTweakersManagerAsync = openTweakersManagerAsync;
exports.openTweakersDoctorAsync = openTweakersDoctorAsync;
exports.readTweakersManagerStatusAsync = readTweakersManagerStatusAsync;
exports.readTweakersManagerStatus = readTweakersManagerStatus;
exports.startTweakersManagerAction = startTweakersManagerAction;
exports.startTweakersManagerActionAsync = startTweakersManagerActionAsync;
exports.readTweakersManagerOfficialSourceRegistration = readTweakersManagerOfficialSourceRegistration;
exports.readTweakersManagerOfficialSourceRegistrationAsync = readTweakersManagerOfficialSourceRegistrationAsync;
exports.startTweakersManagerOfficialSourceRegistration = startTweakersManagerOfficialSourceRegistration;
exports.startTweakersManagerOfficialSourceRegistrationAsync = startTweakersManagerOfficialSourceRegistrationAsync;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const tweakers_sdk_1 = require("@therealityreport/tweakers-sdk");
const MANAGER_ID = "com.thomashulihan.tweakers";
const MANAGER_REQUIREMENT = 'identifier "com.therealityreport.tweakers.manager-launcher" and certificate leaf = H"631275551276127985a524acf1f469bf5164d50d"';
const STATUS_TIMEOUT_MS = 10_000;
const PUBLIC_STATUS_ACTION_IDS = [
    "refresh.injected",
    "refresh.independent",
];
function createTweakersManagerClient(overrides = {}) {
    const deps = {
        homeDirectory: overrides.homeDirectory ?? node_os_1.homedir,
        readText: overrides.readText ?? ((path) => (0, node_fs_1.readFileSync)(path, "utf8")),
        execute: overrides.execute ?? ((executable, args, input) => (0, node_child_process_1.execFileSync)(executable, [...args], {
            encoding: "utf8",
            ...(input === undefined ? {} : { input }),
            timeout: args[0] === "doctor-action" ? 120_000 : STATUS_TIMEOUT_MS,
            maxBuffer: args[0]?.startsWith("doctor-") ? 32 * 1024 * 1024 : 1024 * 1024,
        })),
        executeAsync: overrides.executeAsync ?? ((executable, args, input) => new Promise((resolve, reject) => {
            const child = (0, node_child_process_1.execFile)(executable, [...args], {
                encoding: "utf8",
                timeout: args[0] === "doctor-action" ? 120_000 : STATUS_TIMEOUT_MS,
                maxBuffer: args[0]?.startsWith("doctor-") ? 32 * 1024 * 1024 : 1024 * 1024,
            }, (error, stdout) => error ? reject(error) : resolve(stdout));
            child.stdin?.end(input);
        })),
        spawnDetached: overrides.spawnDetached ?? ((executable, args) => {
            const child = (0, node_child_process_1.spawn)(executable, [...args], { detached: true, stdio: "ignore" });
            child.unref();
        }),
        createId: overrides.createId ?? (() => (0, node_crypto_1.randomUUID)().toLowerCase()),
        now: overrides.now ?? Date.now,
    };
    const signatureCache = new Map();
    const verified = () => verifiedManagerExecutable(deps, signatureCache);
    const statusFromResponse = (response) => {
        if (typeof response.stateToken !== "string" || !/^sha256:[a-f0-9]{64}$/.test(response.stateToken)) {
            throw new Error("Tweakers manager returned an invalid state token");
        }
        if (!response.status || typeof response.status !== "object" || !Array.isArray(response.actions)) {
            throw new Error("Tweakers manager returned a malformed status projection");
        }
        const actions = parsePublicStatusActions(response.actions);
        return {
            stateToken: response.stateToken,
            status: response.status,
            actions,
        };
    };
    const readStatusForExecutable = (executable) => {
        const requestId = deps.createId();
        return statusFromResponse(parseResponse(deps.execute(executable, ["status", "--request-id", requestId, "--json"]), requestId));
    };
    const readStatusForExecutableAsync = async (executable) => {
        const requestId = deps.createId();
        return statusFromResponse(parseResponse(await deps.executeAsync(executable, ["status", "--request-id", requestId, "--json"]), requestId));
    };
    const readStatus = () => readStatusForExecutable(verified());
    let statusInFlight = null;
    const readStatusAsync = () => {
        if (statusInFlight)
            return statusInFlight;
        statusInFlight = (async () => {
            const executable = await verifiedManagerExecutableAsync(deps, signatureCache);
            return readStatusForExecutableAsync(executable);
        })().finally(() => { statusInFlight = null; });
        return statusInFlight;
    };
    const registrationFromResponse = (response) => {
        if (typeof response.stateToken !== "string" || !/^sha256:[a-f0-9]{64}$/.test(response.stateToken)) {
            throw new Error("Tweakers manager returned an invalid official-source registration state token");
        }
        const action = response.officialSourceRegistration;
        if (!action || typeof action !== "object"
            || action.actionId !== "official-source.register"
            || typeof action.available !== "boolean"
            || typeof action.reason !== "string") {
            throw new Error("Tweakers manager returned a malformed official-source registration capability");
        }
        return {
            stateToken: response.stateToken,
            officialSourceRegistration: action,
        };
    };
    const readOfficialSourceRegistrationForExecutable = (executable) => {
        const requestId = deps.createId();
        return registrationFromResponse(parseResponse(deps.execute(executable, [
            "official-source-registration", "--request-id", requestId, "--json",
        ]), requestId));
    };
    const readOfficialSourceRegistrationForExecutableAsync = async (executable) => {
        const requestId = deps.createId();
        return registrationFromResponse(parseResponse(await deps.executeAsync(executable, [
            "official-source-registration", "--request-id", requestId, "--json",
        ]), requestId));
    };
    const startPreparedAction = (executable, actionId, stateToken) => {
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
        return { started: true, operationId };
    };
    const startPreparedActionAsync = async (executable, actionId, stateToken) => {
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
        return { started: true, operationId };
    };
    const startAction = (actionId) => {
        const executable = verified();
        const status = readStatusForExecutable(executable);
        const action = status.actions.find((candidate) => candidate.actionId === actionId);
        if (!action?.available)
            throw new Error(action?.reason ?? `Tweakers manager action ${actionId} is unavailable`);
        return startPreparedAction(executable, actionId, status.stateToken);
    };
    const startActionAsync = async (actionId) => {
        const executable = await verifiedManagerExecutableAsync(deps, signatureCache);
        // Mutations always obtain their own status and token; in-flight UI reads
        // must never authorize a later prepare.
        const status = await readStatusForExecutableAsync(executable);
        const action = status.actions.find((candidate) => candidate.actionId === actionId);
        if (!action?.available)
            throw new Error(action?.reason ?? `Tweakers manager action ${actionId} is unavailable`);
        return startPreparedActionAsync(executable, actionId, status.stateToken);
    };
    const readOfficialSourceRegistration = () => (readOfficialSourceRegistrationForExecutable(verified()));
    const readOfficialSourceRegistrationAsync = async () => (readOfficialSourceRegistrationForExecutableAsync(await verifiedManagerExecutableAsync(deps, signatureCache)));
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
        if (!registration.officialSourceRegistration.available)
            throw new Error(registration.officialSourceRegistration.reason);
        return startPreparedActionAsync(executable, "official-source.register", registration.stateToken);
    };
    const doctorRequest = async (command, input) => {
        const requestId = deps.createId();
        const executable = await verifiedManagerExecutableAsync(deps, signatureCache);
        const response = JSON.parse(await deps.executeAsync(executable, [command, "--request-id", requestId, "--json"], input ? JSON.stringify(input) : undefined));
        if (response.requestId !== requestId || !(0, tweakers_sdk_1.isDoctorReportV1)(response))
            throw new Error("Tweakers Manager returned an invalid Doctor report");
        return response;
    };
    const openManager = (section = "overview") => {
        // Keep this runtime boundary strict even though callers are typed: the
        // detached process is a fixed protocol and must never receive arbitrary UI text.
        if (!(0, tweakers_sdk_1.isTweakersManagerSection)(section))
            throw new Error("Invalid Tweakers Manager section");
        deps.spawnDetached(verified(), [
            "manager-open", "--request-id", deps.createId(), "--section", section, "--json",
        ]);
    };
    const openManagerAsync = async (section = "overview") => {
        if (!(0, tweakers_sdk_1.isTweakersManagerSection)(section))
            throw new Error("Invalid Tweakers Manager section");
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
        doctorAction: (input) => doctorRequest("doctor-action", input),
        openManager,
        openManagerAsync,
        openDoctor,
        openDoctorAsync,
    };
}
const defaultManagerClient = createTweakersManagerClient();
function readTweakersDoctor() { return defaultManagerClient.readDoctor(); }
function runTweakersDoctorAction(input) { return defaultManagerClient.doctorAction(input); }
function openTweakersManager(section = "overview") { defaultManagerClient.openManager(section); }
function openTweakersDoctor() { defaultManagerClient.openDoctor(); }
function openTweakersManagerAsync(section = "overview") { return defaultManagerClient.openManagerAsync(section); }
function openTweakersDoctorAsync() { return defaultManagerClient.openDoctorAsync(); }
function readTweakersManagerStatusAsync() { return defaultManagerClient.readStatusAsync(); }
function readTweakersManagerStatus() {
    return defaultManagerClient.readStatus();
}
function startTweakersManagerAction(actionId) {
    return defaultManagerClient.startAction(actionId);
}
function startTweakersManagerActionAsync(actionId) {
    return defaultManagerClient.startActionAsync(actionId);
}
function readTweakersManagerOfficialSourceRegistration() {
    return defaultManagerClient.readOfficialSourceRegistration();
}
function readTweakersManagerOfficialSourceRegistrationAsync() {
    return defaultManagerClient.readOfficialSourceRegistrationAsync();
}
function startTweakersManagerOfficialSourceRegistration() {
    return defaultManagerClient.startOfficialSourceRegistration();
}
function startTweakersManagerOfficialSourceRegistrationAsync() {
    return defaultManagerClient.startOfficialSourceRegistrationAsync();
}
function managerExecutableIdentity(deps) {
    const descriptorRoot = (0, node_path_1.join)(deps.homeDirectory(), "Library", "Application Support", "Menu Bar", "manager-descriptors");
    const descriptorFile = (0, node_path_1.join)(descriptorRoot, `${MANAGER_ID}.json`);
    let descriptor;
    let descriptorText;
    try {
        descriptorText = deps.readText(descriptorFile);
        descriptor = JSON.parse(descriptorText);
    }
    catch {
        throw new Error("The global Tweakers manager is unavailable or malformed");
    }
    const executable = descriptor.executable;
    const expectedRoot = (0, node_path_1.join)(deps.homeDirectory(), "Library", "Application Support", "Tweakers", "managers", MANAGER_ID, "generations") + node_path_1.sep;
    if (descriptor.schemaVersion !== 1
        || descriptor.managerId !== MANAGER_ID
        || descriptor.protocolVersion !== 1
        || typeof executable !== "string"
        || !(0, node_path_1.isAbsolute)(executable)
        || (0, node_path_1.normalize)(executable) !== executable
        || !executable.startsWith(expectedRoot)
        || (0, node_path_1.basename)(executable) !== "Tweakers Manager Launcher") {
        throw new Error("The global Tweakers manager descriptor is incompatible or blocked");
    }
    try {
        const stat = (0, node_fs_1.statSync)(executable);
        return { executable, signatureKey: `${descriptorText}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
    }
    catch {
        return { executable, signatureKey: null };
    }
}
function verifiedManagerExecutable(deps, signatureCache) {
    const { executable, signatureKey } = managerExecutableIdentity(deps);
    if (signatureKey && signatureCache.get(executable) === signatureKey)
        return executable;
    try {
        deps.execute("/usr/bin/codesign", ["--verify", "--strict", `-R=${MANAGER_REQUIREMENT}`, executable]);
    }
    catch {
        throw new Error("The global Tweakers manager signature is invalid");
    }
    if (signatureKey) {
        if (managerExecutableIdentity(deps).signatureKey !== signatureKey)
            throw new Error("The global Tweakers manager changed during verification");
        signatureCache.set(executable, signatureKey);
    }
    return executable;
}
async function verifiedManagerExecutableAsync(deps, signatureCache) {
    const { executable, signatureKey } = managerExecutableIdentity(deps);
    if (signatureKey && signatureCache.get(executable) === signatureKey)
        return executable;
    try {
        await deps.executeAsync("/usr/bin/codesign", ["--verify", "--strict", `-R=${MANAGER_REQUIREMENT}`, executable]);
    }
    catch {
        throw new Error("The global Tweakers manager signature is invalid");
    }
    const after = managerExecutableIdentity(deps);
    if (after.executable !== executable || after.signatureKey !== signatureKey)
        throw new Error("The global Tweakers manager changed during verification");
    if (signatureKey)
        signatureCache.set(executable, signatureKey);
    return executable;
}
function parseResponse(output, requestId) {
    let response;
    try {
        response = JSON.parse(output);
    }
    catch {
        throw new Error("Tweakers manager returned malformed JSON");
    }
    if (response.protocolVersion !== 1 || response.managerId !== MANAGER_ID || response.requestId !== requestId) {
        throw new Error("Tweakers manager response identity is incompatible");
    }
    if (response.error && typeof response.error === "object") {
        const message = response.error.message;
        throw new Error(typeof message === "string" ? message : "Tweakers manager rejected the request");
    }
    return response;
}
function parsePublicStatusActions(value) {
    if (value.length !== PUBLIC_STATUS_ACTION_IDS.length) {
        throw new Error("Tweakers manager returned an incompatible public action projection");
    }
    const actions = value.map((candidate, index) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            throw new Error("Tweakers manager returned an incompatible public action projection");
        }
        const action = candidate;
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
//# sourceMappingURL=tweakers-manager-client.js.map
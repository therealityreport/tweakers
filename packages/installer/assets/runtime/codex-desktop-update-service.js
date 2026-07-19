"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCodexDesktopUpdateService = createCodexDesktopUpdateService;
const EMPTY_VERSION = {
    marketingVersion: null,
    build: null,
};
function createCodexDesktopUpdateService(dependencies) {
    let checkInFlight = null;
    let presentationInFlight = null;
    let snapshot = null;
    const scheduleRetry = dependencies.scheduleRetry ?? ((retry) => queueMicrotask(retry));
    const recordResult = (result) => {
        snapshot = cloneResult(result);
        try {
            dependencies.onResult?.(cloneResult(result));
        }
        catch {
            // A UI publication failure must never turn a valid metadata check into
            // an updater failure or trigger a second check flight.
        }
        return result;
    };
    const checkSilently = () => {
        if (checkInFlight)
            return checkInFlight;
        const current = runCheck(dependencies).then(recordResult);
        checkInFlight = current;
        const clearFlight = () => {
            if (checkInFlight === current)
                checkInFlight = null;
        };
        void current.then(clearFlight, clearFlight);
        return current;
    };
    const checkAndPresent = () => {
        if (presentationInFlight)
            return presentationInFlight;
        const current = checkSilently().then(async (result) => {
            const presented = await presentResult(dependencies, result);
            if (presented.status !== result.status || presented.reason !== result.reason) {
                recordResult(presented);
            }
            return presented;
        });
        presentationInFlight = current;
        void current.then((result) => {
            if (presentationInFlight === current)
                presentationInFlight = null;
            if (result.retryRequested) {
                scheduleRetry(() => { void checkAndPresent(); });
            }
        }, () => {
            if (presentationInFlight === current)
                presentationInFlight = null;
        });
        return current;
    };
    return {
        checkAndPresent,
        checkSilently,
        getSnapshot: () => snapshot ? cloneResult(snapshot) : null,
    };
}
function cloneResult(result) {
    return {
        ...result,
        installed: { ...result.installed },
        latest: { ...result.latest },
    };
}
async function runCheck(dependencies) {
    let target;
    try {
        target = await dependencies.resolveTarget();
    }
    catch (error) {
        return resultForFailure("error", null, safeError(error));
    }
    if (!target.available) {
        return {
            ...resultForFailure("unavailable", target.profile, target.unavailableReason ?? `${profileLabel(target.profile)} updates are unavailable.`),
            setupRequired: target.setupRequired ?? null,
        };
    }
    let metadata;
    try {
        metadata = await dependencies.refreshMetadata(target);
    }
    catch (error) {
        return resultForFailure("error", target.profile, safeError(error));
    }
    // A refresh failure must not hide a last-known verified newer build. The
    // durable Update and Reload transaction revalidates before changing apps.
    const status = metadata.updateAvailable
        ? "update-available"
        : metadata.stale
            ? "stale"
            : metadata.error
                ? "error"
                : "current";
    return {
        schemaVersion: 1,
        status,
        profile: target.profile,
        installed: { ...metadata.installed },
        latest: { ...metadata.latest },
        checkedAt: metadata.checkedAt,
        reason: metadata.error,
        retryRequested: false,
        updateAndReloadRequested: false,
    };
}
async function presentResult(dependencies, initial) {
    // Alpha setup is an intentional gated state, not a failed network check.
    // Settings renders the guidance inline and the app menu must not open a
    // retry dialog that cannot succeed until the Beta app is registered/run.
    if (initial.setupRequired)
        return initial;
    let response;
    try {
        response = (await dependencies.showDialog(dialogFor(initial))).response;
    }
    catch (error) {
        return { ...initial, status: "error", reason: safeError(error) };
    }
    if (initial.status === "update-available" && response === 0) {
        try {
            await dependencies.startUpdateAndReload();
            return { ...initial, updateAndReloadRequested: true };
        }
        catch (error) {
            return presentResult(dependencies, {
                ...initial,
                status: "error",
                reason: safeError(error),
            });
        }
    }
    const retryRequested = response === 0 && (initial.status === "stale" || initial.status === "unavailable" || initial.status === "error");
    return retryRequested ? { ...initial, retryRequested: true } : initial;
}
function resultForFailure(status, profile, reason) {
    return {
        schemaVersion: 1,
        status,
        profile,
        installed: { ...EMPTY_VERSION },
        latest: { ...EMPTY_VERSION },
        checkedAt: new Date().toISOString(),
        reason,
        retryRequested: false,
        updateAndReloadRequested: false,
    };
}
function dialogFor(result) {
    const profile = result.profile ? profileLabel(result.profile) : "selected";
    const installed = versionLabel(result.installed);
    const latest = versionLabel(result.latest);
    if (result.status === "update-available") {
        return {
            type: "info",
            title: "ChatGPT Update Available",
            message: `ChatGPT ${latest} is available.`,
            detail: `Installed: ${installed}\nRelease profile: ${profile}`,
            buttons: ["Update and Reload", "Later"],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
        };
    }
    if (result.status === "current") {
        return {
            type: "info",
            title: "ChatGPT Is Up to Date",
            message: `ChatGPT ${installed} is the latest available version.`,
            detail: `Release profile: ${profile}`,
            buttons: ["OK"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
        };
    }
    const copy = result.status === "unavailable"
        ? { title: "ChatGPT Updates Unavailable", message: `Updates for ${profile} could not be checked.` }
        : result.status === "stale"
            ? { title: "Could Not Refresh ChatGPT Updates", message: "The last known update information may be out of date." }
            : { title: "Could Not Check for ChatGPT Updates", message: "ChatGPT update information is unavailable." };
    return {
        type: result.status === "error" ? "error" : "info",
        title: copy.title,
        message: copy.message,
        detail: [result.reason, `Release profile: ${profile}`].filter(Boolean).join("\n"),
        buttons: ["Try Again", "OK"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
    };
}
function profileLabel(profile) {
    return profile === "alpha" ? "Alpha (Pre-release)" : "Stable";
}
function versionLabel(version) {
    const marketing = version.marketingVersion ?? "Unavailable";
    return version.build ? `${marketing} (build ${version.build})` : marketing;
}
function safeError(error) {
    return error instanceof Error && error.message ? error.message : "Desktop update check failed.";
}
//# sourceMappingURL=codex-desktop-update-service.js.map
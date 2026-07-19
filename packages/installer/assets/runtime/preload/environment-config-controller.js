"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigCardUpdateCoordinator = void 0;
exports.createEnvironmentConfigController = createEnvironmentConfigController;
exports.desktopUpdateStatusPresentation = desktopUpdateStatusPresentation;
exports.restoreEnvironmentFocus = restoreEnvironmentFocus;
function createEnvironmentConfigController(selected, effects, options = {}) {
    let selectedValue = copySelection(selected);
    let pendingValue = copySelection(selected);
    let busy = false;
    let phase = "idle";
    let error = null;
    const readSnapshot = () => ({
        selected: copySelection(selectedValue),
        pending: copySelection(pendingValue),
        hasPendingChanges: !sameSelection(selectedValue, pendingValue),
        busy,
        phase,
        error,
    });
    const publish = () => options.onChange?.(readSnapshot());
    const finishWithError = (nextPhase, nextError) => {
        error = environmentConfigError(nextError);
        busy = false;
        phase = nextPhase;
        publish();
        return error;
    };
    const completePrepared = async (requested, receipt) => {
        phase = "awaiting-confirmation";
        publish();
        let decision;
        try {
            decision = await effects.confirm(copySelection(requested), receipt);
        }
        catch (confirmationError) {
            return {
                outcome: "confirmation-failed",
                receipt,
                error: finishWithError("idle", confirmationError),
            };
        }
        if (decision === "cancel") {
            phase = "cancelling";
            publish();
            try {
                await effects.cancel(receipt);
            }
            catch (cancelError) {
                return {
                    outcome: "cancel-failed",
                    receipt,
                    error: finishWithError("idle", cancelError),
                };
            }
            pendingValue = copySelection(selectedValue);
            busy = false;
            phase = "idle";
            error = null;
            publish();
            return { outcome: "cancelled", receipt };
        }
        phase = "committing";
        publish();
        try {
            await effects.commit(receipt);
        }
        catch (commitError) {
            return {
                outcome: "commit-failed",
                receipt,
                error: finishWithError("idle", commitError),
            };
        }
        busy = false;
        phase = "idle";
        error = null;
        publish();
        return { outcome: "submitted", receipt };
    };
    return {
        get snapshot() {
            return readSnapshot();
        },
        setSelected(selection) {
            const pendingWasUnchanged = sameSelection(selectedValue, pendingValue);
            selectedValue = copySelection(selection);
            // A status refresh may resolve after the user has staged one half of the
            // Environment pair. Refresh the authoritative selection without erasing
            // that newer local intent; only follow the selected value while the form
            // itself is still pristine.
            if (pendingWasUnchanged)
                pendingValue = copySelection(selection);
            error = null;
            publish();
        },
        restorePending(selection) {
            pendingValue = copySelection(selection);
            publish();
        },
        stageAppExperience(value) {
            if (busy)
                return;
            pendingValue = { ...pendingValue, appExperience: value };
            error = null;
            publish();
        },
        stageReleaseProfile(value) {
            if (busy)
                return;
            pendingValue = { ...pendingValue, releaseProfile: value };
            error = null;
            publish();
        },
        clearError() {
            error = null;
            publish();
        },
        async applyAndRestart() {
            if (busy)
                return { outcome: "busy" };
            if (sameSelection(selectedValue, pendingValue))
                return { outcome: "no-change" };
            const requested = copySelection(pendingValue);
            busy = true;
            phase = "preparing";
            error = null;
            publish();
            let receipt;
            try {
                receipt = await effects.prepare(copySelection(requested));
            }
            catch (prepareError) {
                return {
                    outcome: "prepare-failed",
                    error: finishWithError("idle", prepareError),
                };
            }
            return completePrepared(requested, receipt);
        },
        async resumePrepared(selection, receipt) {
            if (busy)
                return { outcome: "busy" };
            pendingValue = copySelection(selection);
            busy = true;
            error = null;
            return completePrepared(copySelection(selection), receipt);
        },
    };
}
function copySelection(selection) {
    return {
        appExperience: selection.appExperience,
        releaseProfile: selection.releaseProfile,
    };
}
function sameSelection(left, right) {
    return left.appExperience === right.appExperience
        && left.releaseProfile === right.releaseProfile;
}
function environmentConfigError(error) {
    return error instanceof Error ? error.message : String(error || "Unknown error");
}
function desktopUpdateStatusPresentation(status) {
    switch (status) {
        case "current":
            return { label: "Up to date", tone: "ok" };
        case "update-available":
            return { label: "Update available", tone: "warn" };
        case "error":
            return { label: "Error", tone: "error" };
        case "stale":
            return { label: "Stale", tone: "warn" };
        case "unavailable":
            return { label: "Unavailable", tone: "warn" };
        default:
            return { label: "Not checked", tone: "warn" };
    }
}
function restoreEnvironmentFocus(opener, fallback) {
    if (opener?.isConnected) {
        opener.focus();
        return "opener";
    }
    const target = fallback();
    if (target?.isConnected) {
        target.focus();
        return "fallback";
    }
    return "none";
}
/**
 * Keeps asynchronous Config cards independent while rejecting a stale result
 * from an older request for the same card.
 */
class ConfigCardUpdateCoordinator {
    #generations = new Map();
    #values = new Map();
    begin(card) {
        const generation = (this.#generations.get(card) ?? 0) + 1;
        this.#generations.set(card, generation);
        return Object.freeze({ card, generation });
    }
    complete(token, value) {
        if (!this.isCurrent(token))
            return false;
        this.#values.set(token.card, value);
        return true;
    }
    isCurrent(token) {
        return this.#generations.get(token.card) === token.generation;
    }
    invalidate(card) {
        this.#generations.set(card, (this.#generations.get(card) ?? 0) + 1);
    }
    value(card) {
        return this.#values.get(card);
    }
    snapshot() {
        return Object.fromEntries(this.#values);
    }
}
exports.ConfigCardUpdateCoordinator = ConfigCardUpdateCoordinator;
//# sourceMappingURL=environment-config-controller.js.map
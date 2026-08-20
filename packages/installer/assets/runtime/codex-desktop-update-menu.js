"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID = void 0;
exports.environmentModeCacheMenuPresentation = environmentModeCacheMenuPresentation;
exports.syncEnvironmentModeCacheMenuItem = syncEnvironmentModeCacheMenuItem;
exports.environmentModeCacheMenuInputFromStatus = environmentModeCacheMenuInputFromStatus;
exports.syncEnvironmentModeCacheMenuFromStatus = syncEnvironmentModeCacheMenuFromStatus;
exports.syncCodexDesktopUpdateMenuLabel = syncCodexDesktopUpdateMenuLabel;
exports.ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID = "tweakers-environment-mode-cache-status";
function environmentModeCacheMenuPresentation(input) {
    const generation = input.generationId ? `Generation ${input.generationId}` : "No generation";
    const reason = input.invalidationReasons[0];
    if (input.state === "ready") {
        return { label: "Sealed Pair Ready", detail: generation, tone: "ok" };
    }
    if (input.state === "preparing") {
        return { label: "Sealed Pair Preparing", detail: `${generation}${reason ? ` — ${reason}` : ""}`, tone: "warn" };
    }
    if (input.state === "stale") {
        return {
            label: "Sealed Pair Needs Preparation",
            detail: `${generation}${reason ? ` — ${reason}` : ""}; it will not switch automatically`,
            tone: "warn",
        };
    }
    return { label: "Sealed Pair Unavailable", detail: `${generation}${reason ? ` — ${reason}` : ""}`, tone: "warn" };
}
/**
 * Upsert the observational sealed-pair row next to OpenAI's existing update
 * command. The caller owns MenuItem construction; this helper never polls,
 * prepares, pins, validates, or switches an environment.
 */
function syncEnvironmentModeCacheMenuItem(menu, input, createItem) {
    const owner = findCodexDesktopUpdateMenuOwner(menu);
    if (!owner)
        return false;
    const presentation = environmentModeCacheMenuPresentation(input);
    const existing = owner.menu.items.find((item) => item.id === exports.ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID);
    if (existing) {
        existing.label = presentation.label;
        existing.sublabel = presentation.detail;
        existing.enabled = false;
        return true;
    }
    if (!owner.menu.insert)
        return false;
    owner.menu.insert(owner.index + 1, createItem({
        id: exports.ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID,
        label: presentation.label,
        sublabel: presentation.detail,
        enabled: false,
    }));
    return true;
}
function environmentModeCacheMenuInputFromStatus(value) {
    if (!value || typeof value !== "object")
        return null;
    const cache = value.cacheV2;
    if (!cache || typeof cache !== "object")
        return null;
    const candidate = cache;
    if (!candidate.state || !["ready", "preparing", "stale", "unavailable"].includes(candidate.state))
        return null;
    if (candidate.generationId !== null && typeof candidate.generationId !== "string")
        return null;
    if (!Array.isArray(candidate.invalidationReasons)
        || !candidate.invalidationReasons.every((reason) => typeof reason === "string"))
        return null;
    return {
        state: candidate.state,
        generationId: candidate.generationId ?? null,
        invalidationReasons: candidate.invalidationReasons,
    };
}
function syncEnvironmentModeCacheMenuFromStatus(menu, status, createItem) {
    const input = environmentModeCacheMenuInputFromStatus(status);
    return input === null ? false : syncEnvironmentModeCacheMenuItem(menu, input, createItem);
}
/** Updates OpenAI's existing item in place, preserving its original click action. */
function syncCodexDesktopUpdateMenuLabel(menu, updateAvailable, onManualCheck, alphaSetupRequired = false) {
    const updateItem = findCodexDesktopUpdateMenuItem(menu);
    if (!updateItem)
        return false;
    updateItem.label = alphaSetupRequired
        ? "Alpha Updates Require Setup…"
        : updateAvailable ? "Update Available…" : "Check for Updates…";
    updateItem.enabled = !alphaSetupRequired;
    if (onManualCheck) {
        updateItem.click = onManualCheck;
    }
    return true;
}
function findCodexDesktopUpdateMenuItem(menu) {
    for (const item of menu.items) {
        if (item.label === "Check for Updates…"
            || item.label === "Update Available…"
            || item.label === "Alpha Updates Require Setup…")
            return item;
        if (item.submenu) {
            const nested = findCodexDesktopUpdateMenuItem(item.submenu);
            if (nested)
                return nested;
        }
    }
    return null;
}
function findCodexDesktopUpdateMenuOwner(menu) {
    for (let index = 0; index < menu.items.length; index += 1) {
        const item = menu.items[index];
        if (!item)
            continue;
        if (item.label === "Check for Updates…"
            || item.label === "Update Available…"
            || item.label === "Alpha Updates Require Setup…")
            return { menu, index };
        if (item.submenu) {
            const nested = findCodexDesktopUpdateMenuOwner(item.submenu);
            if (nested)
                return nested;
        }
    }
    return null;
}
//# sourceMappingURL=codex-desktop-update-menu.js.map
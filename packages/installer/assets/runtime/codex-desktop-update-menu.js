"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncCodexDesktopUpdateMenuLabel = syncCodexDesktopUpdateMenuLabel;
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
//# sourceMappingURL=codex-desktop-update-menu.js.map
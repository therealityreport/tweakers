"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findDesktopUpdateFooterMount = findDesktopUpdateFooterMount;
exports.startDesktopUpdateIndicator = startDesktopUpdateIndicator;
const electron_1 = require("electron");
const desktop_update_indicator_state_1 = require("./desktop-update-indicator-state");
const UPDATE_CHANGED_CHANNEL = "tweaker:codex-desktop-update-changed";
const INDICATOR_ATTRIBUTE = "data-tweaker-desktop-update-indicator";
function findDesktopUpdateFooterMount(root = document) {
    const anchors = Array.from(root.querySelectorAll("[aria-label]"));
    for (const anchor of anchors) {
        const label = anchor.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
        if (!/(settings|account|profile|help)/.test(label))
            continue;
        let candidate = anchor;
        for (let depth = 0; candidate && depth < 6; depth += 1) {
            const role = candidate.getAttribute("role");
            if (candidate.matches("nav, aside, footer") || role === "navigation" || role === "contentinfo") {
                return candidate;
            }
            candidate = candidate.parentElement;
        }
    }
    return null;
}
function startDesktopUpdateIndicator() {
    let current = null;
    let indicator = null;
    let warningTimer = null;
    const warnedIdentities = new Set();
    const removeIndicator = () => {
        indicator?.remove();
        indicator = null;
        if (warningTimer)
            clearTimeout(warningTimer);
        warningTimer = null;
    };
    const scheduleMissingMountWarning = (identity) => {
        if (warningTimer || warnedIdentities.has(identity))
            return;
        warningTimer = setTimeout(() => {
            warningTimer = null;
            if (!current || !(0, desktop_update_indicator_state_1.shouldShowDesktopUpdateIndicator)(current))
                return;
            if ((0, desktop_update_indicator_state_1.desktopUpdateIndicatorIdentity)(current) !== identity || findDesktopUpdateFooterMount())
                return;
            warnedIdentities.add(identity);
            console.warn(`[tweaker] ChatGPT update ${identity} is available, but no semantic sidebar footer mount point was found.`);
        }, 3_000);
    };
    const render = () => {
        if (!(0, desktop_update_indicator_state_1.shouldShowDesktopUpdateIndicator)(current)) {
            removeIndicator();
            return;
        }
        const identity = (0, desktop_update_indicator_state_1.desktopUpdateIndicatorIdentity)(current);
        const mount = findDesktopUpdateFooterMount();
        if (!mount) {
            indicator?.remove();
            indicator = null;
            scheduleMissingMountWarning(identity);
            return;
        }
        if (warningTimer)
            clearTimeout(warningTimer);
        warningTimer = null;
        if (!indicator) {
            indicator = document.createElement("button");
            indicator.type = "button";
            indicator.setAttribute(INDICATOR_ATTRIBUTE, "true");
            indicator.setAttribute("aria-label", "ChatGPT update available");
            indicator.textContent = "Update";
            Object.assign(indicator.style, {
                appearance: "none",
                border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
                borderRadius: "9999px",
                background: "color-mix(in srgb, currentColor 10%, transparent)",
                color: "inherit",
                cursor: "pointer",
                font: "inherit",
                fontSize: "12px",
                fontWeight: "600",
                margin: "6px 10px",
                padding: "5px 10px",
            });
            indicator.addEventListener("click", () => {
                indicator.disabled = true;
                void electron_1.ipcRenderer.invoke("tweaker:check-codex-desktop-update")
                    .finally(() => {
                    if (indicator?.isConnected)
                        indicator.disabled = false;
                });
            });
        }
        indicator.title = `ChatGPT ${current?.latest?.marketingVersion ?? "update"} is available`;
        if (indicator.parentElement !== mount)
            mount.appendChild(indicator);
    };
    const onChanged = (_event, value) => {
        current = value && typeof value === "object" ? value : null;
        render();
    };
    electron_1.ipcRenderer.on(UPDATE_CHANGED_CHANNEL, onChanged);
    const observer = new MutationObserver(render);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    void electron_1.ipcRenderer.invoke("tweaker:get-codex-desktop-update")
        .then((value) => onChanged(undefined, value))
        .catch(() => { });
    return () => {
        electron_1.ipcRenderer.removeListener(UPDATE_CHANGED_CHANNEL, onChanged);
        observer.disconnect();
        removeIndicator();
    };
}
//# sourceMappingURL=desktop-update-indicator.js.map
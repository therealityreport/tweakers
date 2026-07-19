"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldShowDesktopUpdateIndicator = shouldShowDesktopUpdateIndicator;
exports.desktopUpdateIndicatorIdentity = desktopUpdateIndicatorIdentity;
function shouldShowDesktopUpdateIndicator(state) {
    return state?.status === "update-available" && state.nativeUpdateControlActive !== true;
}
function desktopUpdateIndicatorIdentity(state) {
    return [state.latest?.marketingVersion ?? "unknown", state.latest?.build ?? "unknown"].join(":");
}
//# sourceMappingURL=desktop-update-indicator-state.js.map
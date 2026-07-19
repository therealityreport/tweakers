"use strict";
/**
 * App-mode switching: ChatGPT ⇄ Tweakers bundle swap, renderer-triggered.
 *
 * `/Applications/ChatGPT.app` alternates between two payloads: the pristine
 * OpenAI Developer-ID bundle ("chatgpt" mode) and the patched,
 * contained-signed bundle ("tweakers" mode). The switch itself — quitting the
 * app, swapping bundles, relaunching — is owned entirely by the installer CLI
 * (`tweaker mode <target> --yes`). The runtime's only job is to validate the
 * renderer's request and hand off to that CLI.
 *
 * Two invariants callers must uphold:
 * - The renderer shows its own confirmation BEFORE invoking this; nothing on
 *   this path prompts the user.
 * - The CLI must be started through the launchd-submit seam
 *   (`startInstalledCliWithLaunchd` in main.ts), never a plain child spawn:
 *   the helper has to survive this app quitting and the live bundle being
 *   swapped out from under it mid-flight.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSwitchAppModePayload = parseSwitchAppModePayload;
exports.appModeLabel = appModeLabel;
exports.switchAppMode = switchAppMode;
/** Strict payload shape: exactly `{ target: "chatgpt" | "tweakers" }`. */
function parseSwitchAppModePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const keys = Object.keys(payload);
    if (keys.length !== 1 || keys[0] !== "target")
        return null;
    const target = payload.target;
    return target === "chatgpt" || target === "tweakers" ? target : null;
}
function appModeLabel(mode) {
    return mode === "chatgpt" ? "ChatGPT App" : "Tweakers";
}
function switchAppMode(payload, deps) {
    const target = parseSwitchAppModePayload(payload);
    if (!target) {
        return { ok: false, message: 'Invalid app mode request; expected { target: "chatgpt" | "tweakers" }.' };
    }
    if (target === deps.currentMode) {
        return { ok: false, message: `The app is already in ${appModeLabel(target)} mode.` };
    }
    const cli = deps.resolveCli();
    if (!deps.cliExists(cli)) {
        return { ok: false, message: "Tweakers installer CLI is unavailable. Run the installer once, then try again." };
    }
    if (!deps.startCliWithLaunchd(cli, ["mode", target, "--yes"])) {
        return { ok: false, message: "Could not start the mode-switch helper. Check the Tweakers log for details." };
    }
    return { ok: true, message: `Switching to ${appModeLabel(target)}; the app will quit and relaunch.` };
}
//# sourceMappingURL=app-mode.js.map